ship::
	rsync -r --filter=':- .gitignore' . prod-ddex:fut
	ssh prod-ddex -t 'fut/node_modules/.bin/pm2 start ddex'
