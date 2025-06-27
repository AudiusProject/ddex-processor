
stage::
	npm run build
	rsync -r --filter=':- .gitignore' . stage-ddex:fut
	ssh stage-ddex -t 'cd fut && npm i && docker compose up -d && node_modules/.bin/pm2 start worker && node_modules/.bin/pm2 start ddex'

prod::
	npm run build
	rsync -r --filter=':- .gitignore' . prod-ddex:fut
	ssh prod-ddex -t 'cd fut && npm i && node_modules/.bin/pm2 start worker && node_modules/.bin/pm2 start ddex'


test::
	docker compose -f compose.test.yml down --volumes && docker compose -f compose.test.yml up -d
	 DB_URL=postgres://postgres:test@127.0.0.1:40112/postgres npm run test


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

reset-database::
	PGPASSWORD=example psql \
		-U postgres \
		-d postgres \
		-p 40111 \
		-h 127.0.0.1 \
		-c "drop schema public cascade; create schema public;"

psql::
	psql postgresql://postgres:example@localhost:40111/ddex1
