'use strict'
require('./support/common')
const _ = require('lodash');
const db = require('./support/db')
const jobqueue = require('../lib')
const Job = require('../lib/job')

describe('Job Queue', function() {

    before(function() {
        // drop and create the database and install schema
        return db.destroyAndCreate().then((queue) => {
            this.queue = queue
        })
    })

    beforeEach(function() {
        return this.queue.clearAllJobs()
    })

    describe('checkDatabase', function() {
        it('should succeed when the database is OK', function() {
            return this.queue.checkDatabase()
        })
        it('should fail when the database not OK', function() {
            var queue = new jobqueue('postgres://127.0.0.1:61548/unknown')
            return expect(queue.checkDatabase()).to.eventually.be.rejected
        })
    })

    describe('addJob should throw an exception when called with invalid arguments', function() {
        this.validJob = {
            type: 'sendMail',
            scheduledFor: new Date(),
            maxAttempts: 1,
            data: {}
        }

        it('should reject non-objects', function() {
            expect(() => this.queue.addJob(1)).to.throw(TypeError)
        })

        it('should reject scheduledFor specified with non-date', function() {
            var job = _.extend({}, this.validJob, {scheduledFor: 123})
            expect(() => this.queue.addJob(job)).to.throw(TypeError)
        })

        it('should reject invalid type', function() {
            var job = _.extend({}, this.validJob, {type: 123})
            expect(() => this.queue.addJob(job)).to.throw(TypeError)
        })

        it('should reject invalid maxAttempts', function() {
            var job = _.extend({}, this.validJob, {maxAttempts: 123})
            expect(() => this.queue.addJob(job)).to.throw(TypeError)

            job = _.extend({}, this.validJob, {maxAttempts: -123})
            expect(() => this.queue.addJob(job)).to.throw(TypeError)
        })
    })

    it('should accept a new job and then process it once', function() {

        function jobHandler(job, queue) {
            // send email to job.data.recipient, message=job.data.message
            return job.finish()
        }

        var spy = sinon.spy(jobHandler)

        // setup a single job handler
        this.queue.setHandlers({
            sendEmail: spy
        })

        var job = {
            type: 'sendEmail',
            data: {
                recipient: 'user@example.com',
                message: 'HELLO'
            }
        }


        // add a job
        return this.queue.addJob(job).then(() => {
            // process the job
            return this.queue.processNextJob().then(() => {

                // check the handler was called correctly
                expect(spy.calledOnce).to.be.true
                expect(spy.getCall(0).args[0].data).to.deep.equal(job.data)

                // try and process the job again (should fail)
                return expect(this.queue.processNextJob()).to.eventually.be.rejected
            })
        })
    })

    it('should resolve job types as paths', function() {
        function jobHandler(job, queue) {
            // send email to job.data.recipient, message=job.data.message
            return job.finish()
        }

        var spy = sinon.spy(jobHandler)

        // setup a single job handler
        this.queue.setHandlers({
            emails: {
                subgroup: {
                    welcome: spy
                }
            }
        })

        // define the job
        var job = {
            type: 'emails.subgroup.welcome',
            data: {
                recipient: 'user@example.com',
                message: 'HELLO'
            }
        }
        // add the job
        return this.queue.addJob(job).then(() => {
            // process the job
            return this.queue.processNextJob().then(() => {

                // check the handler was called correctly
                expect(spy.calledOnce).to.be.true
                expect(spy.getCall(0).args[0].data).to.deep.equal(job.data)

                // try and process the job again (should fail)
                return expect(this.queue.processNextJob()).to.eventually.be.rejected
            })
        })
    })

    it('should resolve a job handler from a path', function() {
        var handlers = {
            email: {
                subgroup: {
                    welcome: () => {}
                }
            },
            sendEmail: () => {}
        }
        this.queue.setHandlers(handlers)
        var welcome = this.queue.resolveHandler('email.subgroup.welcome')
        expect(welcome).to.equal(handlers.email.subgroup.welcome)
        var sendEmail = handlers.sendEmail
        expect(sendEmail).to.equal(handlers.sendEmail)
    })

    it('should determine available job types', function() {
        var handlers = {
            testJob: () => {},
            emails: {
                subgroup: {
                    welcome: () => {},
                    goodbye: () => {},
                }
            }
        }
        this.queue.setHandlers(handlers)
        var expected = [
            'testJob',
            'emails.subgroup.welcome',
            'emails.subgroup.goodbye',
        ]
        var types = this.queue.getAvailableJobTypes()

        // sort them both
        types = _.sortBy(types)
        expected = _.sortBy(expected)
        expect(_.isEqual(types, expected))
    })


    it('should mark a job as failed if it throws an exception', function() {
        this.queue.setHandlers({
            failingJob: function() {
                throw new Error('error message')
            }
        })

        var job = {
            type: 'failingJob',
            maxAttempts: 1
        }


        return this.queue.addJob(job)
        .then(() => this.queue.processNextJob())
        .then(() => this.queue.getFailedJobs())
        .then(function(jobs) {
            expect(jobs.length).to.equal(1)
            var job = jobs[0]
            expect(job.failedAttempts).to.equal(1)
            expect(job.lastFailureMessage).to.equal('error message')
        })
    })

    it('should retry a failed job `maxAttempts` times', function() {
        this.queue.setHandlers({
            failingJob: function(job) {
                return job.fail(new Error('error message'), new Date())
            }
        })
        var job = {
            type: 'failingJob',
            maxAttempts: 5
        }
        return this.queue.addJob(job)
        .then(() => {
            var loop = () => {
                return this.queue.processNextJob().then(() => {
                    return loop()
                })
            }
            return loop()
        }).catch((e) => {
            if (!(e instanceof this.queue.errors.JobQueueEmpty)) {
                throw e
            }
        }).then(() => {
            // job has been run many times and should have reached complete failure
            // check that is true
            return this.queue.getFailedJobs().then(function(jobs) {
                expect(jobs.length).to.equal(1)
                var job = jobs[0]
                expect(job.state).to.equal('failed')
                expect(job.failedAttempts).to.equal(5)
                expect(job.maxAttempts).to.equal(5)
                expect(job.lastFailureMessage).to.equal('error message')
            })
        })
    })

    it('should fail a job when job.fail() is called', function() {
        this.queue.setHandlers({
            failingJob: function(job) {
                return job.fail(new Error('error message'))
            }
        })
        var job = {
            type: 'failingJob'
        }
        return this.queue.addJob(job)
        .then(() => {
            var loop = () => {
                return this.queue.processNextJob().then(() => loop())
            }
            return loop()
        }).catch((e) => {
            if (!(e instanceof this.queue.errors.JobQueueEmpty)) {
                throw e
            }
        }).then(() => {
            // job has been run many times and should have reached complete failure
            // check that is true
            return this.queue.getFailedJobs().then((jobs) => {
                expect(jobs.length).to.equal(1)
                var job = jobs[0]
                expect(job.state).to.equal('failed')
                expect(job.failedAttempts).to.equal(1)
                expect(job.maxAttempts).to.equal(1)
                expect(job.lastFailureMessage).to.equal('error message')
            })
        })

    })

    it('should correctly reschedule a job', function*() {
        this.queue.setHandlers({
            rescheduleJob: function(job) {
                return job.reschedule(new Date())
            }
        })

        var job = {
            type: 'rescheduleJob',
        }
        yield this.queue.addJob(job)
        yield this.queue.processNextJob()
        yield this.queue.processNextJob()


        var count = yield this.queue.waitingCount()
        expect(count).to.equal(1)
    })

    describe('should update lastRun', function() {
        it('for a rescheduled job', function*() {
            this.queue.setHandlers({
                rescheduleJob: function(job) {
                    return job.reschedule(new Date())
                }
            })
            var job = {
                type: 'rescheduleJob',
            }

            
            var start = new Date()
            // deduct 1 second, because 'pg' module cannot handle microseconds
            start.setSeconds(start.getSeconds() - 1)
            
            // add the job to the queue and process it
            yield this.queue.addJob(job)
            yield this.queue.processNextJob()

            // verify that lastRun column has been correctly updated
            var allJobs = yield this.queue.getAllJobs()
            expect(allJobs).to.have.length(1)
            var _job = allJobs[0]
            expect(_job.lastRun).afterTime(start)
            expect(_job.lastRun).beforeTime(new Date())
        })
        
        it('for a finished job', function*() {
            this.queue.setHandlers({
                sendmail: function(job) { }
            })
            var job = {
                type: 'sendmail',
            }

            
            var start = new Date()
            // deduct 1 second, because 'pg' module cannot handle microseconds
            start.setSeconds(start.getSeconds() - 1)
            
            // add the job to the queue and process it
            yield this.queue.addJob(job)
            yield this.queue.processNextJob()

            // verify that lastRun column has been correctly updated
            var allJobs = yield this.queue.getAllJobs()
            expect(allJobs).to.have.length(1)
            var _job = allJobs[0]
            expect(_job.lastRun).afterTime(start)
            expect(_job.lastRun).beforeTime(new Date())
        })

        it('for a failed job', function*() {
            this.queue.setHandlers({
                failingJob: function(job) {
                    throw new Error("error")
                }
            })
            var job = {
                type: 'failingJob',
            }

            
            var start = new Date()
            // deduct 1 second, because 'pg' module cannot handle microseconds
            start.setSeconds(start.getSeconds() - 1)
            
            // add the job to the queue and process it
            yield this.queue.addJob(job)
            yield this.queue.processNextJob()

            // verify that lastRun column has been correctly updated
            var allJobs = yield this.queue.getFailedJobs()
            expect(allJobs).to.have.length(1)
            var _job = allJobs[0]
            expect(_job.lastRun).afterTime(start)
            expect(_job.lastRun).beforeTime(new Date())
        })
    })


    it('should only process jobs with handlers available', function() {
        var job = {
            type: 'sendmail',
        }
        return this.queue.addJob(job)
        .then(() => {
            // processNextJob should throw the error JobQueueEmpty
            // because we haven't setup any handlers, so it doesn't see the job
            return expect(this.queue.processNextJob()).to.eventually.be.rejectedWith(this.queue.errors.JobQueueEmpty)
        })
    })

    it('should not allow multiple threads to acquire the same job', function() {
        // initialize 2 jobqueue instances to the same database
        var queue1 = new jobqueue(db.connectionString)
        var queue2 = new jobqueue(db.connectionString)

        // the job we will use to test
        var job = {
            type: 'slowJob',
        }
        var handlers = {
            slowJob: function(job) {
                return Promise.delay(100).then(() => {
                    return job.finish()
                })
            }
        }

        // a wrapper around processNextJob(), that returns false on error
        function catchProcessJobError(queue) {
            return queue.processNextJob().then(() => {
                return true
            }).catch((e) => {
                return false
            })
        }

        // use the same handlers for both jobqueues
        queue1.setHandlers(handlers)
        queue2.setHandlers(handlers)

        // add the test job
        return queue1.addJob(job).then(() => {
            // try and process the job with 2 threads
            return Promise.join(
                catchProcessJobError(queue1),
                catchProcessJobError(queue2),
                function(result1, result2) {
                    // one of the queues should succeeed (it acquires the job and processes it successfully)
                    // the other queue should fail (it cannot acquire the already acquired job)
                    expect(result1 != result2).to.be.true
                })
        })
    })

    it('should allow jobs to destroy themselves', function() {
        this.queue.setHandlers({
            testjob: function(job) {
                return job.destroy()
            }
        })
        var job = {
            type: 'testjob'
        }

        return this.queue.addJob(job)
        .then(() => {
            return this.queue.waitingCount().then((count) => {
                expect(count).to.equal(1)
            })
        })
        .then(() => this.queue.processNextJob())
        .then(() => {
            return this.queue.failedCount().then((count) => {
                expect(count).to.equal(0)
            })
        })
        .then(() => {
            return this.queue.waitingCount().then((count) => {
                expect(count).to.equal(0)
            })
        })
    })

    it('should call the configured error handler', function() {
        var errorHandler = sinon.spy()

        this.queue.setHandlers({
            // special error handler method
            $errorHandler: errorHandler,
            failingJob: function(job) {
                throw new Error("error")
            }
        })
        var job = {
            type: 'failingJob'
        }
        return this.queue.addJob(job)
        .then(() => this.queue.processNextJob())
        .then(() => {
            // check the error handler was called correctly
            expect(errorHandler.calledOnce).to.be.true
            var args = errorHandler.getCall(0).args
            expect(args[0]).to.be.an.instanceof(Error)
            expect(args[1]).to.be.an.instanceof(Job)
        })
    })

    describe('$logHandler should be called', function() {

        it('for a failing job', function* () {
            var logHandler = sinon.spy()

            this.queue.setHandlers({
                // special error handler method
                $logHandler: logHandler,
                failingJob: function(job) {
                    throw new Error("error")
                }
            })

            /* for a failing job */
            yield this.queue.addJob({type: 'failingJob'})
            yield this.queue.processNextJob()

            expect(logHandler.calledTwice).to.be.true
            
            var firstCallArgs = logHandler.getCall(0).args
            expect(firstCallArgs[0]).to.equal('starting')
            expect(firstCallArgs[1]).to.be.an.instanceof(Job)

            var secondCallArgs = logHandler.getCall(1).args
            expect(secondCallArgs[0]).to.equal('failed')
            expect(secondCallArgs[1]).to.be.an.instanceof(Job)

        })
    
        it('for a healthy job', function*() {
            var logHandler = sinon.spy()

            this.queue.setHandlers({
                // special error handler method
                $logHandler: logHandler,
                
                healthyJob: function(job) {
                }
            })

            yield this.queue.addJob({type: 'healthyJob'})
            yield this.queue.processNextJob()

            expect(logHandler.calledTwice).to.be.true
            
            var firstCallArgs = logHandler.getCall(0).args
            expect(firstCallArgs[0]).to.equal('starting')
            expect(firstCallArgs[1]).to.be.an.instanceof(Job)

            var secondCallArgs = logHandler.getCall(1).args
            expect(secondCallArgs[0]).to.equal('finished')
            expect(secondCallArgs[1]).to.be.an.instanceof(Job)
        })

        it('for a rescheduling job', function*() {
            var logHandler = sinon.spy()

            this.queue.setHandlers({
                // special error handler method
                $logHandler: logHandler,
                
                reschedulingJob: function(job) {
                    return job.reschedule(new Date())
                }
            })

            yield this.queue.addJob({type: 'reschedulingJob'})
            yield this.queue.processNextJob()

            expect(logHandler.calledThrice).to.be.true
            
            var firstCallArgs = logHandler.getCall(0).args
            expect(firstCallArgs[0]).to.equal('starting')
            expect(firstCallArgs[1]).to.be.an.instanceof(Job)

            var secondCallArgs = logHandler.getCall(1).args
            expect(secondCallArgs[0]).to.equal('rescheduled')
            expect(secondCallArgs[1]).to.be.an.instanceof(Job)

            var thirdCallArgs = logHandler.getCall(2).args
            expect(thirdCallArgs[0]).to.equal('finished')
            expect(thirdCallArgs[1]).to.be.an.instanceof(Job)
        })
    })
})

