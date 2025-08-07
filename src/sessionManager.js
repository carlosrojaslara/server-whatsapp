// sessionManager.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import axios from 'axios';
import pino from "pino";
import fs from 'fs';

export const qrs = {}; // QR por cliente_id

const sesiones = {}; // Map<cliente_id, socket>

export async function iniciarSesion(cliente_id) {
    if (sesiones[cliente_id]) return sesiones[cliente_id];

    const basePath = `./sessions`;
    if (!fs.existsSync(basePath)) {
        fs.mkdirSync(basePath);
    }

    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${cliente_id}`);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "warn" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log(`🔑 QR para ${cliente_id}:`, qr);
            qrs[cliente_id] = qr; // Guardamos el QR para ese cliente

            // Podés emitirlo vía WebSocket al frontend
        }
        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;

            if (reason === DisconnectReason.loggedOut || reason === 401) {
                console.log(`❌ ${cliente_id} cerró sesión o fue removido desde otro dispositivo.`);

                // 🔥 Eliminá la carpeta de sesión si existe
                const dir = `./sessions/${cliente_id}`;
                if (fs.existsSync(dir)) {
                    fs.rmSync(dir, { recursive: true, force: true });
                    console.log(`🧹 Carpeta de sesión eliminada: ${dir}`);
                }

                delete qrs[cliente_id];

                delete sesiones[cliente_id];
            } else {
                console.log(`🔁 Reintentando conexión para ${cliente_id}...`);
                delete sesiones[cliente_id];
                iniciarSesion(cliente_id);
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        console.log("messages", messages);
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // ⛔ Ignorar estados y difusiones
        if (msg.key.remoteJid === 'status@broadcast' || msg.broadcast) {
            console.log("📢 Mensaje de difusión o estado ignorado:", msg.key.remoteJid);
            return;
        }
        if (!msg.message || msg.key.fromMe) return;
        const ctx = {
            from: msg.key.remoteJid.split("@")[0],     // número del cliente
            body: msg.message?.conversation || msg.message?.extendedTextMessage?.text || "",
            name: msg.pushName || "Sin nombre",
            host: cliente_id,                           // lo agregás vos
            key: msg.key,
            message: msg.message.conversation,
        };

        try {
            const response = await axios.post("http://localhost:4000/api/whatsapp", {
                host: ctx.host,
                from: ctx.from,
                message: ctx.body,
                name: ctx.name
            });
            console.log("🧾 Respuesta del backend (NO enviada aún):", response.data);

            // const respuestaTexto = response.data?.respuesta?.respuesta || "✅ Mensaje recibido.";
            // const partes = respuestaTexto.split(/\n\n+/);

            // for (const parte of partes) {
            //     const textoLimpio = parte.trim().replace(/【.*?】[ ] /g, "");

            //     // 🔽 Enviás la respuesta directamente
            //     await sock.sendMessage(`${ctx.from}@s.whatsapp.net`, {
            //         text: textoLimpio,
            //     });
            // }
        } catch (error) {
            console.error("❌ Error reenviando al backend o respondiendo:", error.message);
            await sock.sendMessage(`${ctx.from}@s.whatsapp.net`, {
                text: "⚠️ Ocurrió un error procesando tu mensaje.",
            });
        }
    });

    sesiones[cliente_id] = sock;
    return sock;
}

export function getSesion(cliente_id) {
    return sesiones[cliente_id];
}
