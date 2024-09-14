const async = require('async');

const queue = async.queue((task, callback) => {
    task.fn().then(callback).catch(callback);
}, 20);

queue.concurrency = 45;

module.exports = queue;
