# pg-job-queue

A job queue for node.js based on PostgreSQL.

[![npm version](https://badge.fury.io/js/pg-job-queue.svg)](https://badge.fury.io/js/pg-job-queue)
[![Build Status](https://travis-ci.org/jameshy/pg-job-queue.svg?branch=master)](https://travis-ci.org/jameshy/pg-job-queue)


## Installation
```bash
npm install pg-job-queue
```

## Create a job

```javascript
var jobQueue = require('pg-job-queue')
jobQueue.connect('postgres://postgres@localhost/my-job-queue')
.then(() => {
    return jobQueue.addJob({
        type: 'sendEmail',
        data: {
            toAddress: 'demo@example.com',
            message: 'hello'
        }
    })
})
```


## Process jobs as they arrive

```javascript
var jobQueue = require('pg-job-queue')

var handlers = {
    sendEmail: function(job) {
        return sendMail(job.data.toAddress, job.data.message).then(() => {
            return job.finish()
        })
    }
}

jobQueue.connect('postgres://postgres@localhost/my-job-queue')
.then(jobQueue.startProcessing)
```

## License
[MIT](LICENSE)
