#!/usr/bin/env node
;(async () => {
	require('../patch/array.flat')
	const { LOCAL_DIR } = require('./data')
	const logger = require('./log')
	const axios = require('axios')
	const path = require('path')
	const fs = require('fs')

	const SRC_DIR = path.resolve(process.cwd() + '/src')
	if (
		process.argv[2] !== 'bootstrap' &&
		!fs.statSync(SRC_DIR).isDirectory()
	) {
		logger.error("no 'src' folder found, exiting...")
		process.env.WRITE_PERSISTENT = true
		process.exit(1)
	}
	const SAVE_DIR = path.resolve(process.cwd(), './.mcproject')
	const PROJECT_LOC = path.resolve(SAVE_DIR, 'PROJECT.json')

	if (!process.argv.includes('-offline')) {
		logger.info('checking for updates...')
		const remotepkg = await axios
			.get('https://unpkg.com/mc-build@latest/package.json')
			.then(res => res.data)
		if (require('../../package.json').version != remotepkg.version) {
			logger.warn(
				"there is an update to mc-build available, to install it run 'npm i -g mc-build@latest'"
			)
		}
	}
	if (process.argv[2] === 'bootstrap') {
		return require('./bootstrap')()
	}
	if (process.argv.includes('-offline')) {
		require('./secondary_entry')
	} else if (process.argv[2] === 'add') {
		const type = process.argv[3]
		const name = process.argv[4]
		let names = []
		names = name.split(',')
		names = names.filter(e => e)
		languages = names.length
		logger.task('fetching manifest...')
		const manifest = await axios
			.get('https://api.mcbuild.dev/catalog')
			.then(res => res.data)
		logger.task('validating...')
		let errored = false
		const project = require(PROJECT_LOC)
		if (type === 'lib') {
			if (!manifest.libs.includes(name)) {
				logger.error(`did not find entry library '${name}' in manifest`)
				errored = true
			}
		} else if (type === 'lang') {
			if (!manifest.langs.includes(name)) {
				logger.error(
					`did not find entry for language '${name}' in manifest`
				)
				errored = true
			}
		} else if (type === 'langs') {
			for (let i = 0; i < names.length; i++) {
				if (!manifest.langs.includes(names[i])) {
					logger.error(
						`did not find entry for language '${names[i]}' in manifest`
					)
					errored = true
				}
			}
		}
		if (errored) {
			process.exit(1)
		}

		if (type === 'lib') {
			logger.info('adding library...')
			const lib = await axios
				.get('https://api.mcbuild.dev/lib/' + name)
				.then(res => res.data)
				.catch(e => {
					logger.error('failed to get library')
					process.exit(1)
				})
			const newName = lib.name
			if (project.libs.find(lib => lib.name === newName)) {
				logger.error('library is already in the current project')
				process.exit(1)
			} else {
				project.libs.push(lib)
			}
			fs.writeFileSync(PROJECT_LOC, JSON.stringify(project, null, 2))
			logger.info('finished adding library to project!')
			process.exit(0)
		} else if (type === 'lang') {
			logger.info('adding language...')
			const lang = await axios
				.get('https://api.mcbuild.dev/lang/' + name)
				.then(res => res.data)
				.catch(e => {
					logger.error('failed to get language')
					process.exit(1)
				})
			const newName = lang.name
			if (project.languages.find(lib => lib.name === newName)) {
				logger.error(
					'language is already included in the current project'
				)
				process.exit(1)
			} else {
				project.languages.push(lang)
			}
			fs.writeFileSync(PROJECT_LOC, JSON.stringify(project, null, 2))
			logger.info('finished adding language to project!')
			process.exit(0)
		} else if (type === 'langs') {
			logger.info('adding languages...')
			for (let i = 0; i < names.length; i++) {
				const lang = await axios
					.get('https://api.mcbuild.dev/lang/' + names[i])
					.then(res => res.data)
					.catch(e => {
						logger.error(`failed to get language ${names[i]}`)
					})
				const newName = lang.name
				if (project.languages.find(lib => lib.name === newName)) {
					logger.error(
						`language ${names[i]} is already included in the current project`
					)
				} else {
					project.languages.push(lang)
				}
				fs.writeFileSync(PROJECT_LOC, JSON.stringify(project, null, 2))
			}
			logger.info('finished adding languages to project!')
			process.exit(0)
		}
	} else {
		const download = require('download')
		const { performance } = require('perf_hooks')
		const thread = require('child_process')
		const rimraf = require('rimraf')

		function removeDir(dir) {
			return new Promise((resolve, reject) => {
				rimraf(dir, error => {
					if (error) reject(error)
					resolve()
				})
			})
		}

		let manifest = {
			languages: [
				{
					name: 'lang-mc/stable',
					remote: {
						type: 'github',
						owner: 'mc-build',
					},
				},
			],
			libs: [],
		}
		if (!fs.existsSync(SAVE_DIR)) {
			fs.mkdirSync(SAVE_DIR)
		}
		if (fs.existsSync(PROJECT_LOC)) {
			manifest = require(PROJECT_LOC)
		} else {
			fs.writeFileSync(PROJECT_LOC, JSON.stringify(manifest, null, 2))
			manifest = require(PROJECT_LOC)
		}

		if (!manifest.libs) {
			manifest.libs = []
			fs.writeFileSync(PROJECT_LOC, JSON.stringify(manifest, null, 2))
		}

		function resolveOfTypeFrom(type, item) {
			switch (item.remote.type) {
				case 'github': {
					let [name, version] = item.name.split('/')
					version = version || 'stable'
					return axios
						.get(
							`https://api.github.com/repos/${item.remote.owner}/${name}/branches/${version}`
						)
						.then(res => res.data)
						.then(async data => {
							if (
								data.hasOwnProperty('message') &&
								data.message.startsWith(
									'API rate limit exceeded'
								)
							) {
								await axios
									.get('https://api.github.com/rate_limit', {
										headers: {
											Accept: 'application/vnd.github.v3+json',
										},
									})
									.then(res => res.data)
									.then(data => {
										let resetTime = data.rate.reset
										let currentTime = Math.floor(
											Date.now() / 1000
										)
										let timeZone =
											-new Date().getTimezoneOffset() * 60
										let remainingTime =
											resetTime - currentTime
										let remaining =
											remainingTime > 59
												? `${Math.floor(
														remainingTime / 60
												  )} minutes and ${
														remainingTime % 60
												  } seconds`
												: `${remainingTime} seconds`
										const fail = require('./error_loggers')
										try {
											throw new Error(
												`Wait until ${new Date(
													(resetTime + timeZone) * 1e3
												)
													.toISOString()
													.slice(
														-13,
														-5
													)} or use the -offline to bypass the update check if you have the languages downloaded already`
											)
										} catch (e) {
											fail.critical(
												`Github rate limit exceeded, please wait ${remaining}`,
												e,
												true
											)
										}
									})
							} else {
								return Promise.resolve({
									_raw: data,
									sha: data.commit.sha,
									item: item,
									type,
									name,
									version,
								})
							}
						})
						.then(data => data)
				}
				case 'file': {
					let [name, version] = item.name.split('/')
					return Promise.resolve({
						_raw: item,
						sha: 'NO_SHA_LANG_LOADED_FROM_FILE_SYSTEM',
						item: item,
						type,
						name,
						version,
					})
				}
			}
		}
		if (!manifest.libs) {
			manifest.libs = []
			fs.writeFileSync(PROJECT_LOC, JSON.stringify(manifest, null, 2))
		}
		const promises = manifest.languages.map(language =>
			resolveOfTypeFrom('language', language)
		)
		promises.push(
			...manifest.libs.map(lib => resolveOfTypeFrom('library', lib))
		)
		const download_tasks = []
		;(await Promise.all(promises)).forEach(task => {
			if (!fs.existsSync(path.resolve(LOCAL_DIR, task.sha))) {
				download_tasks.push(task)
			}
		})
		if (!fs.existsSync(path.resolve(LOCAL_DIR))) {
			fs.mkdirSync(path.resolve(LOCAL_DIR), { recursive: true })
		}
		if (!fs.existsSync(path.resolve(LOCAL_DIR, '.cache'))) {
			fs.mkdirSync(path.resolve(LOCAL_DIR, '.cache'), { recursive: true })
		}
		for (let i = 0; i < download_tasks.length; i++) {
			const start = performance.now()
			const task = download_tasks[i]
			const item = task.item
			const category = task.type
			let { name, version } = task
			const TARGET_DIR = path.resolve(
				LOCAL_DIR,
				'.cache',
				category,
				task.name,
				version
			)
			let DISK_DIR = TARGET_DIR
			if (item.remote.type === 'github') {
				const SHA_PATH = path.resolve(LOCAL_DIR, '.sha', category, name)
				console.log(SHA_PATH)
				if (
					fs.existsSync(
						path.resolve(path.resolve(SHA_PATH, version))
					) &&
					task.sha ===
						fs.readFileSync(
							path.resolve(SHA_PATH, version),
							'utf-8'
						)
				) {
					logger.log(
						'using cache for ' +
							task.type +
							" '" +
							task.item.name +
							"'"
					)
				} else {
					version = version || 'stable'
					logger.info(
						`downloading ${
							task.type
						} ${name} branch ${version} from '${`https://github.com/${task.item.remote.owner}/${name}/archive/${task.sha}.zip'`}`
					)
					removeDir(TARGET_DIR)
					await download(
						`https://github.com/${task.item.remote.owner}/${name}/archive/${task.sha}.zip`,
						TARGET_DIR,
						{
							extract: true,
							strip: 1,
						}
					)
					logger.info('installing dependencies')
					try {
						const cp = require('child_process').execSync('npm i', {
							cwd: TARGET_DIR,
						})
						logger.info('succesully installed dependencies')
					} catch (e) {
						logger.error('failed to install dependencies')
					}
					if (!fs.existsSync(SHA_PATH)) {
						fs.mkdirSync(SHA_PATH, { recursive: true })
					}
					fs.writeFileSync(path.resolve(SHA_PATH, version), task.sha)
					const end = performance.now()
					logger.info(`finished download in ${end - start}ms`)
				}
			}
			if (item.remote.type === 'file') {
				DISK_DIR = item.remote.path
			}
			if (
				task.type === 'library' &&
				!fs.existsSync(path.resolve(DISK_DIR, 'build.json'))
			) {
				await new Promise(resolve => {
					const start = performance.now()
					logger.log(`building library ${name}!`)
					const cp = thread.exec(
						[
							JSON.stringify(process.argv[0]),
							path.resolve(__dirname, '..', '..', 'cli.js'),
							'-lib=' + name,
							'-build',
						].join(' '),
						{
							cwd: DISK_DIR,
						}
					)
					cp.stdout.on('data', message => {
						process.stdout.write(message.toString())
					})
					cp.stderr.on('data', message => {
						process.stderr.write(message.toString())
					})
					cp.on('error', error => {
						throw error
					})
					cp.on('exit', () => {
						logger.log(
							`done building library ${name} in ${
								performance.now() - start
							}ms!`
						)
						resolve()
					})
				})
			}

			item.remote._loc = DISK_DIR
		}
		logger.log('starting mc-build...')
		require('./secondary_entry')
	}
})()
