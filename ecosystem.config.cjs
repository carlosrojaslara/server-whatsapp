// ecosystem.baileys.config.js
module.exports = {
    apps: [
        {
            name: "baileys-gw",
            cwd: "/var/www/server-whatsapp",
            script: "./src/app.js",          // <— tu entrypoint (el que hace app.listen)
            exec_mode: "fork",              // 1 sola instancia; NO cluster para sesiones
            instances: 1,
            time: true,
            watch: false,
            autorestart: true,
            exp_backoff_restart_delay: 200,
            kill_timeout: 10000,
            out_file: "/var/log/baileys/out.log",
            error_file: "/var/log/baileys/err.log",
            merge_logs: true,
            max_memory_restart: "600M"
        }
    ]
}
