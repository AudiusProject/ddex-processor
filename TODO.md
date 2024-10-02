# TODO

* filter by source in UI / artist / etc.
* source payout wallet config
* zero downtime deploy: [graceful shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/) + [cluster mode](https://pm2.keymetrics.io/docs/usage/cluster-mode/#cluster-mode)


## Support UpdateMessage

Currently processing assumes the media files are co-located with the XML... but not so with updates.
When UpdateIndicator=UpdateMessage XML is submitted... it won't have the sound files or image files.
Only UpdateIndicator=OriginalMessage will contain the actual media files.
Usually these updates are to update some aspect of the deal XML structure...
For now just skiping UpdateMessages as all the observed examples has been to add a deal for Ringtone Downloads...

Plan to support updates:
- For OriginalMessage pull the resources (sound + image + text) into a new table like:

```
source,releaseId,collection,ref,url

somesource,8010203,Image,A0,s3://somesource-prod-raw/a/b/c/A0.mp3
somesource,8010203,SoundRecording,A1,s3://somesource-prod-raw/a/b/c/A1.jpeg
```

- write a function to resolve ref via `(source,releaseId,colleciton,ref)`.
  The `collection` bit might not be fully necessary as all examples thus far have had unique refs across collections... but you never know.



## Clean Shutdown for Publisher

Related to zero downtime deploy...

* pm2 in cluster mode should start new process + signal old process to exit
* SIGINT handler should keep app alive till any in-flight publish is complete
* configure long exit timeout to allow this.
