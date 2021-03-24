/*
**  Vingester ~ Ingest Web Contents as Video Streams
**  Copyright (c) 2021 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  require internal modules  */
const os          = require("os")
const path        = require("path")
const fs          = require("fs")
const process     = require("process")

/*  require external modules  */
const electron    = require("electron")
const log         = require("electron-log")
const Store       = require("electron-store")
const debounce    = require("throttle-debounce").debounce
const jsYAML      = require("js-yaml")
const grandiose   = require("grandiose")
const tesladon    = require("tesladon")
const Jimp        = require("jimp")

/*  require own modules  */
const pkg         = require("./package.json")

/*  etablish reasonable logging environment  */
if (typeof process.env.DEBUG !== "undefined") {
    log.transports.file.level    = "debug"
    log.transports.console.level = "debug"
}
else {
    log.transports.file.level    = "info"
    log.transports.console.level = false
}
log.transports.remote.level   = false
log.transports.ipc.level      = false
log.transports.console.format = "Vingester: {h}:{i}:{s}.{ms} > [{level}] {text}"
log.transports.file.format    = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}"
log.debug(`(find persistent log under ${log.transports.file.getFile()})`)

/*  redirect exception error boxes to the console  */
electron.dialog.showErrorBox = (title, content) => {
    log.info(`UI: exception: ${title}: ${content}`)
}

/*  enter an asynchronous environment in main process  */
;(async () => {
    /*  determine versions  */
    const version = {
        vingester: pkg.version,
        electron:  process.versions.electron,
        chromium:  process.versions.chrome,
        v8:        process.versions.v8.replace(/-electron.*$/, ""),
        node:      process.versions.node,
        ndi:       grandiose.version().replace(/^.+\s+/, "")
    }
    electron.ipcMain.handle("version", (ev) => { return version })
    log.info(`main: starting Vingester: ${version.vingester}`)
    log.info(`main: using Electron: ${version.electron}`)
    log.info(`main: using Chromium: ${version.chromium}`)
    log.info(`main: using V8: ${version.v8}`)
    log.info(`main: using Node: ${version.node}`)
    log.info(`main: using NDI: ${version.ndi}`)

    /*  initialize store  */
    const store = new Store()

    /*  optionally and early disable GPU hardware accelleration  */
    if (!store.get("gpu")) {
        log.info("main: disabling GPU hardware accelleration (explicitly configured)")
        electron.app.disableHardwareAcceleration()
    }

    /*  helper class for weighted average calculations  */
    class WeightedAverage {
        constructor (len, every) {
            this.len   = len
            this.every = every
            this.val   = []
            this.cnt   = 0
            this.max   = Number.NEGATIVE_INFINITY
            this.min   = Number.POSITIVE_INFINITY
            for (let i = 0; i < len; i++)
                this.val[i] = 0
        }
        record (val, callback) {
            this.val.pop()
            this.val.unshift(val)
            let avg = 0
            let div = 0
            let max = Number.NEGATIVE_INFINITY
            let min = Number.POSITIVE_INFINITY
            for (let i = 0; i < this.len; i++) {
                if (max < this.val[i]) max = this.val[i]
                if (min > this.val[i]) min = this.val[i]
                const k = this.len - i
                avg += this.val[i] * k
                div += k
            }
            avg /= div
            if (this.max < max) this.max = max
            if (this.min > max) this.min = max
            if (this.cnt++ > this.every) {
                this.cnt = 0
                callback({
                    avg, min, max,
                    tmin: this.min, tmax: this.max
                })
            }
        }
    }

    /*  helper class for browser abstraction  */
    class Browser {
        constructor (id, cfg, mainWin) {
            log.info("main: browser: constructor")
            this.id              = id
            this.cfg             = cfg
            this.win             = null
            this.subscribed      = false
            this.ndiSender       = null
            this.ndiFramesToSkip = 0
            this.frames          = 0
            this.burst           = null
            this.factor          = 1.0
            this.framerate       = 30
            this.mainWin         = mainWin
        }
        reconfigure (cfg) {
            log.info("main: browser: reconfigure")
            Object.assign(this.cfg, cfg)
            this.update()
        }
        running () {
            return (this.win !== null)
        }
        async start () {
            log.info("main: browser: start")

            /*  determine window title  */
            const title = (this.cfg.t == null ? "Vingester" : this.cfg.t)

            /*  determine scale factor and width/height  */
            this.factor = electron.screen.getPrimaryDisplay().scaleFactor
            const width  = Math.round(parseInt(this.cfg.w) / this.factor)
            const height = Math.round(parseInt(this.cfg.h) / this.factor)

            /*  determine display  */
            const point = electron.screen.getCursorScreenPoint()
            let D = electron.screen.getDisplayNearestPoint(point)
            let m
            if (this.cfg.d !== null && (m = this.cfg.d.match(/^([-+]?[01]),([-+]?[01])$/))) {
                const d = electron.screen.getPrimaryDisplay()
                const w = d.size.width
                const h = d.size.height
                const point = {
                    x: (w * 0.5) + parseInt(m[1]) * w,
                    y: (w * 0.5) + parseInt(m[2]) * h
                }
                D = electron.screen.getDisplayNearestPoint(point)
            }

            /*  determine position  */
            let pos = {}
            if (this.cfg.x !== null && this.cfg.y !== null) {
                const x = Math.round(D.bounds.x + (parseInt(this.cfg.x) / this.factor))
                const y = Math.round(D.bounds.y + (parseInt(this.cfg.y) / this.factor))
                pos = { x, y }
            }

            /*  create new browser window  */
            const opts1 = (this.cfg.D ? {
                ...pos,
                width:           width,
                height:          height,
                useContentSize:  false,
                autoHideMenuBar: true,
                frame:           false,
                hasShadow:       false,
                backgroundColor: this.cfg.c,
                fullscreenable:  true,
                titleBarStyle:   "hidden",
                thickFrame:      false,
                title:           title
            } : {
                width:           width,
                height:          height,
                useContentSize:  false,
                show:            false
            })
            const opts2 = (this.cfg.D ? {
            } : {
                offscreen:       true
            })
            const win = new electron.BrowserWindow({
                ...opts1,
                webPreferences: {
                    ...opts2,
                    devTools:                   (typeof process.env.DEBUG !== "undefined"),
                    backgroundThrottling:       false,
                    preload:                    path.join(__dirname, "vingester-preload.js"),
                    nodeIntegration:            true,
                    nodeIntegrationInWorker:    true,
                    disableDialogs:             true,
                    autoplayPolicy:             "no-user-gesture-required",
                    spellcheck:                 false,
                    zoomFactor:                 1.0 / this.factor
                }
            })

            /*  force aspect ratio  */
            win.setAspectRatio(parseInt(this.cfg.w) / parseInt(this.cfg.h))

            /*  force always on top  */
            if (this.cfg.p) {
                /*  show window higher than all regular windows, but still behind
                    things like spotlight or the screen saver and allow the window to
                    show over a fullscreen window  */
                win.setAlwaysOnTop(true, "floating", 1)
                win.setVisibleOnAllWorkspaces(true)
            }
            else {
                win.setAlwaysOnTop(false)
                win.setVisibleOnAllWorkspaces(false)
            }

            /*  capture and send browser frame content  */
            this.framerate = (this.cfg.N ? parseInt(this.cfg.f) : D.displayFrequency)
            this.ndiSender = (this.cfg.N ? await grandiose.send({
                name:       title,
                clockVideo: true,
                clockAudio: false
            }) : null)
            this.burst = new WeightedAverage(this.framerate, this.framerate / 2)
            if (this.cfg.D) {
                /*  use Frame subscription where framerate cannot be controlled
                    (but which is available also for onscreen rendering)  */
                this.ndiFramesToSkip = Math.trunc((D.displayFrequency / this.framerate) - 1)
                if (this.cfg.N || this.cfg.P) {
                    win.webContents.beginFrameSubscription(false, (image, dirty) => {
                        return this.processFrame(image, dirty)
                    })
                    this.subscribed = true
                }
            }
            else if (this.cfg.N) {
                /*  use Paint hook where framerate can be controlled
                    (but which is available for offscreen rendering only)  */
                this.ndiFramesToSkip = 0
                win.webContents.on("paint", (ev, dirty, image) => {
                    return this.processFrame(image, dirty)
                })
                win.webContents.setFrameRate(this.framerate)
                win.webContents.startPainting()
            }

            /*  receive statistics  */
            win.webContents.on("ipc-message", (ev, channel, msg) => {
                if (channel === "stat" && this.mainWin !== null)
                    this.mainWin.webContents.send("stat", { ...msg, id: this.id })
            })

            /*  react on window events  */
            win.on("close", (ev) => {
                ev.preventDefault()
                this.destroy()
            })
            win.on("page-title-updated", (ev) => {
                ev.preventDefault()
                /*  FIXME  */
            })
            win.webContents.on("did-fail-load", (ev) => {
                ev.preventDefault()
                /*  FIXME  */
            })

            /*  load the URL  */
            win.loadURL(this.cfg.u)

            this.win = win
            log.info("main: browser: started")
        }
        update () {
            if (this.win !== null) {
                if (this.cfg.D) {
                    if (this.subscribed && !this.cfg.P) {
                        this.win.webContents.endFrameSubscription()
                        this.subscribed = false
                    }
                    else if (!this.subscribed && this.cfg.P) {
                        this.win.webContents.beginFrameSubscription(false, (image, dirty) => {
                            return this.processFrame(image, dirty)
                        })
                        this.subscribed = true
                    }
                }
            }
        }
        async processFrame (image, dirty) {
            if (!(this.cfg.N || this.cfg.P))
                return
            const t0 = Date.now()

            /*  fetch image  */
            const size   = image.getSize()
            const buffer = image.getBitmap()

            /*  send preview capture frame  */
            if (this.cfg.P) {
                const img = await new Promise((resolve, reject) => {
                    new Jimp({ data: buffer, width: size.width, height: size.height }, (err, image) => {
                        if (err)
                            reject(err)
                        else
                            resolve(image)
                    })
                })
                img.resize(128, 72, Jimp.RESIZE_BILINEAR)
                if (os.endianness() === "LE") {
                    /*  convert from BGRA (chrome "paint") to RGBA (canvas) if necessary  */
                    img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
                        const B = this.bitmap.data[idx]
                        this.bitmap.data[idx] = this.bitmap.data[idx + 2]
                        this.bitmap.data[idx + 2] = B
                    })
                }
                this.mainWin.webContents.send("capture", {
                    buffer: img.bitmap.data,
                    size: {
                        width: img.bitmap.width,
                        height: img.bitmap.height
                    },
                    id: this.id
                })
            }

            /*  send NDI video frame  */
            if (this.cfg.N) {
                if (this.frames++ > this.ndiFramesToSkip) {
                    this.frames = 0
                    const ptp = tesladon.tsTimeToPTPTime(t0)
                    const frame = {
                        type:               "video",
                        xres:               size.width,
                        yres:               size.height,
                        frameRateN:         this.framerate * 1000,
                        frameRateD:         1000,
                        fourCC:             grandiose.FOURCC_BGRA,
                        pictureAspectRatio: image.getAspectRatio(this.factor),
                        timestamp:          ptp,
                        timecode:           [ ptp[0] / 100, ptp[1] / 100 ],
                        frameFormatType:    grandiose.FORMAT_TYPE_PROGRESSIVE,
                        lineStrideBytes:    size.width * 4,
                        data:               buffer
                    }
                    await this.ndiSender.video(frame)
                }
            }

            /*  record processing time  */
            const t1 = Date.now()
            this.burst.record(t1 - t0, (stat) => {
                this.mainWin.webContents.send("burst", { ...stat, id: this.id })
            })
        }
        reload () {
            log.info("main: browser: reload")
            if (this.win === null)
                throw new Error("still not started")
            this.win.reload()
        }
        async stop () {
            log.info("main: browser: stop")
            if (this.win === null)
                throw new Error("still not started")
            this.win.close()
            await new Promise((resolve) => {
                setTimeout(() => {
                    if (this.win !== null) {
                        if (!this.win.isDestroyed())
                            this.win.destroy()
                        this.win = null
                    }
                    resolve()
                }, 1000)
            })
            log.info("main: browser: stopped")
        }
        destroy () {
            log.info("main: browser: destroy")
            if (this.win === null)
                throw new Error("still not started")
            this.win.destroy()
            this.win = null
        }
    }

    /*  once electron is ready...  */
    electron.app.on("ready", async () => {
        log.info("main: Electron is now ready")

        /*  determine main window position and size  */
        log.info("main: loading persistant settings")
        const x = store.get("control.x", null)
        const y = store.get("control.y", null)
        const w = store.get("control.w", 810)
        const h = store.get("control.h", 320)
        const pos = (x !== null && y !== null ? { x, y } : {})

        /*  create main window  */
        log.info("main: creating control user interface")
        const mainWin = new electron.BrowserWindow({
            ...pos,
            width:           w,
            height:          h,
            minWidth:        810,
            minHeight:       320,
            title:           "Vingester",
            backgroundColor: "#333333",
            useContentSize:  false,
            webPreferences: {
                devTools:                   (typeof process.env.DEBUG !== "undefined"),
                nodeIntegration:            true,
                nodeIntegrationInWorker:    true,
                contextIsolation:           false,
                worldSafeExecuteJavaScript: true,
                disableDialogs:             true,
                enableRemoteModule:         false,
                autoplayPolicy:             "no-user-gesture-required",
                spellcheck:                 false
            }
        })
        mainWin.removeMenu()
        if (typeof process.env.DEBUG !== "undefined") {
            setTimeout(() => {
                mainWin.webContents.openDevTools()
            }, 1000)
        }

        /*  persist main window position and size  */
        const updateBounds = () => {
            const bounds = mainWin.getBounds()
            store.set("control.x", bounds.x)
            store.set("control.y", bounds.y)
            store.set("control.w", bounds.width)
            store.set("control.h", bounds.height)
        }
        mainWin.on("resize", debounce(1000, () => {
            updateBounds()
        }))
        mainWin.on("move", debounce(1000, () => {
            updateBounds()
        }))

        /*  provide IPC hooks for store access  */
        log.info("main: provide IPC hooks for control user interface")
        electron.ipcMain.handle("browsers-load", async (ev) => {
            return store.get("browsers")
        })
        electron.ipcMain.handle("browsers-save", async (ev, browsers) => {
            store.set("browsers", browsers)
        })
        electron.ipcMain.handle("browsers-export", async (ev) => {
            electron.dialog.showSaveDialog({
                title:       "Choose Export File (YAML)",
                properties:  [ "openFile" ],
                filters:     [ { name: "YAML", extensions: [ "yaml" ] } ],
                defaultPath: electron.app.getPath("userData")
            }).then(async (result) => {
                if (result.canceled)
                    return
                if (result.filePath) {
                    const file = result.filePath
                    const browsers = JSON.parse(store.get("browsers"))
                    const yaml = jsYAML.dump(browsers)
                    await fs.promises.writeFile(file, yaml, { encoding: "utf8" })
                    return true
                }
                return false
            }).catch(() => {
                return false
            })
        })
        electron.ipcMain.handle("browsers-import", async (ev) => {
            return electron.dialog.showOpenDialog({
                title:       "Choose Import File (YAML)",
                properties:  [ "openFile" ],
                filters:     [ { name: "YAML", extensions: [ "yaml" ] } ],
                defaultPath: electron.app.getPath("userData")
            }).then(async (result) => {
                if (result.canceled)
                    return
                if (result.filePaths && result.filePaths.length === 1) {
                    const file = result.filePaths[0]
                    const yaml = await fs.promises.readFile(file, { encoding: "utf8" })
                    const browsers = jsYAML.load(yaml)
                    store.set("browsers", JSON.stringify(browsers))
                    return true
                }
                return false
            }).catch(() => {
                return false
            })
        })

        /*  provide IPC hooks for browsers control  */
        log.info("main: provide IPC hooks for browser control")
        const browsers = {}
        const control = async (action, id, cfg) => {
            if (action === "add") {
                /*  add browser configuration  */
                browsers[id] = new Browser(id, cfg, mainWin)
            }
            else if (action === "mod") {
                /*  modify browser configuration  */
                browsers[id].reconfigure(cfg)
            }
            else if (action === "del") {
                /*  delete browser configuration  */
                if (browsers[id] !== undefined)
                    browsers[id].stop()
                delete browsers[id]
            }
            else if (action === "start-all") {
                /*  start all browsers  */
                for (const id of Object.keys(browsers))
                    if (!browsers[id].running())
                        control("start", id)
            }
            else if (action === "reload-all") {
                /*  reload all browsers  */
                for (const id of Object.keys(browsers))
                    if (browsers[id].running())
                        control("reload", id)
            }
            else if (action === "stop-all") {
                /*  stop all browsers  */
                for (const id of Object.keys(browsers))
                    if (browsers[id].running())
                        control("stop", id)
            }
            else if (action === "start") {
                /*  start a particular browser  */
                const browser = browsers[id]
                if (browser === undefined)
                    throw new Error("invalid browser id")
                if (browser.running())
                    throw new Error("browser already running")
                mainWin.webContents.send("browser-start", id)
                await browser.start()
                mainWin.webContents.send("browser-started", id)
            }
            else if (action === "reload") {
                /*  reload a particular browser  */
                const browser = browsers[id]
                if (browser === undefined)
                    throw new Error("invalid browser id")
                if (!browser.running())
                    throw new Error("browser still not running")
                mainWin.webContents.send("browser-reload", id)
                browser.reload()
                mainWin.webContents.send("browser-reloaded", id)
            }
            else if (action === "stop") {
                /*  stop a particular browser  */
                const browser = browsers[id]
                if (browser === undefined)
                    throw new Error("invalid browser id")
                if (!browser.running())
                    throw new Error("browser still not running")
                mainWin.webContents.send("browser-stop", id)
                await browser.stop()
                mainWin.webContents.send("browser-stopped", id)
            }
        }
        electron.ipcMain.handle("control", (ev, action, id, browser) => {
            browser = browser !== undefined && browser !== null ? JSON.parse(browser) : undefined
            return control(action, id, browser)
        })

        /*  explicitly allow capturing our windows  */
        log.info("main: provide hook for permissions checking")
        electron.session.fromPartition("default").setPermissionRequestHandler((webContents, permission, callback) => {
            const allowedPermissions = [ "audioCapture", "desktopCapture", "pageCapture", "tabCapture", "experimental" ]
            if (allowedPermissions.includes(permission))
                callback(true)
            else {
                log.error(`The application tried to request permission for '${permission}'.` +
                    "This permission was not whitelisted and has been blocked.")
                callback(false)
            }
        })

        /*  load web content  */
        log.info("main: loading control user interface")
        mainWin.loadURL(`file://${path.join(__dirname, "vingester-control.html")}`)
        mainWin.webContents.on("did-fail-load", (ev) => {
            electron.app.quit()
        })

        /*  wait until control UI is created  */
        log.info("main: awaiting control user interface to become ready")
        let controlReady = false
        electron.ipcMain.handle("control-created", (event) => {
            controlReady = true
        })
        await new Promise((resolve) => {
            const check = () => {
                if (controlReady)
                    resolve()
                else
                    setTimeout(check, 100)
            }
            setTimeout(check, 100)
        })

        /*  toggle GPU hardware accelleration  */
        log.info("main: send GPU status and provide IPC hook for GPU status change")
        mainWin.webContents.send("gpu", !!store.get("gpu"))
        electron.ipcMain.handle("gpu", async (ev, gpu) => {
            const choice = electron.dialog.showMessageBoxSync(mainWin, {
                message: `${gpu ? "Enabling" : "Disabling"} GPU hardware accelleration ` +
                    "requires an application restart.",
                type: "question",
                buttons: [ "Restart", "Cancel" ],
                cancelId: 1
            })
            if (choice === 1)
                return
            store.set("gpu", gpu)
            mainWin.webContents.send("gpu", gpu)
            electron.app.relaunch()
            electron.app.exit()
        })

        /*  collect metrics  */
        log.info("main: start usage gathering timer")
        const usages = new WeightedAverage(20, 5)
        let timer = setInterval(() => {
            if (timer === null)
                return
            const metrics = electron.app.getAppMetrics()
            let usage = 0
            for (const metric of metrics)
                usage += metric.cpu.percentCPUUsage
            usages.record(usage, (stat) => {
                mainWin.webContents.send("usage", stat.avg)
            })
        }, 100)

        /*  gracefully shutdown application  */
        log.info("main: hook into control user interface window states")
        mainWin.on("close", async (ev) => {
            log.info("main: shuting down")
            ev.preventDefault()
            if (timer !== null) {
                clearTimeout(timer)
                timer = null
            }
            await control("stop-all", null)
            updateBounds()
            mainWin.destroy()
        })
        electron.app.on("window-all-closed", () => {
            electron.app.quit()
        })
        electron.app.on("will-quit", () => {
            log.info("main: terminating")
        })

        log.info("main: up and running")
    })
})().catch((err) => {
    if (log)
        log.error(`Vingester: ERROR: ${err}`)
    else
        console.log(`Vingester: ERROR: ${err}`)
})

