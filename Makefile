ship::
	npm run build
	rsync -r --filter=':- .gitignore' . prod-ddex:fut
	ssh prod-ddex -t 'fut/node_modules/.bin/pm2 start ddex'

DATE := $(shell date +%Y-%m-%d)
FOLDER := backups/$(DATE)
backup::
	mkdir -p $(FOLDER)
	rsync prod-ddex:fut/data/* $(FOLDER)
