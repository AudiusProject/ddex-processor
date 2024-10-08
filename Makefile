
stage::
	npm run build
	rsync -r --filter=':- .gitignore' . stage-ddex:fut
	ssh stage-ddex -t 'cd fut && npm i && node_modules/.bin/pm2 start ddex'

prod::
	npm run build
	rsync -r --filter=':- .gitignore' . prod-ddex:fut
	ssh prod-ddex -t 'cd fut && npm i && node_modules/.bin/pm2 start ddex'


DATE := $(shell date +%Y-%m-%d)
FOLDER := backups/$(DATE)
backup::
	mkdir -p $(FOLDER)
	rsync prod-ddex:fut/data/* $(FOLDER)
