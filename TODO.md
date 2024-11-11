# TODO

* generate partial CLM on interval
* pagination / search / filter stuff



## Clean Shutdown for Publisher

zero downtime deploy: [graceful shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/) + [cluster mode](https://pm2.keymetrics.io/docs/usage/cluster-mode/#cluster-mode)

* pm2 in cluster mode should start new process + signal old process to exit
* SIGINT handler should keep app alive till any in-flight publish is complete
* configure long exit timeout to allow this.
