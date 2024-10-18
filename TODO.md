# TODO

* filter by source in UI / artist / etc.
* source payout wallet config
* zero downtime deploy: [graceful shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/) + [cluster mode](https://pm2.keymetrics.io/docs/usage/cluster-mode/#cluster-mode)



## Clean Shutdown for Publisher

Related to zero downtime deploy...

* pm2 in cluster mode should start new process + signal old process to exit
* SIGINT handler should keep app alive till any in-flight publish is complete
* configure long exit timeout to allow this.
