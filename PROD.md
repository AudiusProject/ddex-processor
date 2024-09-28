* Install [nodejs](https://deb.nodesource.com/)
* Setup a [Cloudflare Tunne](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)


Make Restart-able:

```bash
pm2 startup
# copy paste the line as instructed
pm2 save
```

## deploy

```bash
make
```


