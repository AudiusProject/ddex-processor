
stage::
	npm run build
	rsync -r --filter=':- .gitignore' . stage-ddex:fut
	ssh stage-ddex -t 'cd fut && npm i && node_modules/.bin/pm2 start worker && node_modules/.bin/pm2 start ddex'

prod::
	npm run build
	rsync -r --filter=':- .gitignore' . prod-ddex:fut
	ssh prod-ddex -t 'cd fut && npm i && node_modules/.bin/pm2 start worker && node_modules/.bin/pm2 start ddex'


DATE := $(shell date +%Y-%m-%d)
STAGE_FOLDER := backups/stage/$(DATE)
backup.stage::
	mkdir -p $(STAGE_FOLDER)
	rsync -z stage-ddex:fut/data/* $(STAGE_FOLDER)

FOLDER := backups/$(DATE)
backup.prod::
	mkdir -p $(FOLDER)
	time rsync -z prod-ddex:fut/data/* $(FOLDER)


adminer::
	open http://localhost:40222/?pgsql=db&username=postgres

psql::
	psql postgresql://postgres:example@localhost:40111/postgres
