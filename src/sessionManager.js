// sessionManager.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import axios from 'axios';
import pino from "pino";
import fs from 'fs';

export const qrs = {};
const sesiones = {};

export const sessionState = new Map(); // cliente_id -> { status, ts }


export async function iniciarSesion(cliente_id) {
    const hostPhone = cliente_id; // <- el teléfono del negocio (host) que te llega al iniciar sesión
    const isNumberLike = (s) => {
        if (!s) return false;
        const t = String(s).replace(/\s|\+|-/g, '');
        return /^\d{6,}$/.test(t); // 6+ dígitos = seguramente es un número
    };

    const pickBestName = (...candidatos) => {
        for (const c of candidatos) {
            if (c && !isNumberLike(c)) return c;
        }
        // si todos son números, devolvemos el primero no vacío (será el tel)
        return candidatos.find(Boolean) || null;
    };

    /**
     * Resuelve un nombre “mostrable” para un JID
     * - contactNameMap: Map(jid -> name) armado desde `contacts`
     * - chatMetaMap: Map(jid -> { name, subject, pushName }) armado desde `chats`
     * - msgPushName: string con m.pushName (cuando exista)
     */
    function resolveDisplayName({ jid, contactNameMap, chatMetaMap, msgPushName }) {
        const tel = jid?.split('@')[0] || null;
        const fromContacts = contactNameMap.get(jid);
        const fromChatMeta = chatMetaMap.get(jid) || {};
        const candidato = pickBestName(
            msgPushName,              // 1) pushName del mensaje si vino
            fromContacts,             // 2) nombre desde contacts
            fromChatMeta.name,        // 3) name/subject/pushName del chat
            fromChatMeta.subject,
            fromChatMeta.pushName,
            tel                       // 4) fallback número
        );
        return candidato || tel || 'Sin nombre';
    }

    const getTextFromMessage = (m) =>
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
        "";

    const toItem = (m) => ({
        text:
            m.message?.conversation ||
            m.message?.extendedTextMessage?.text ||
            m.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
            "",
        from_me: !!m.key?.fromMe,
        wa_message_id: m.key?.id || null,
        wa_timestamp: Number(m.messageTimestamp) || null, // 👈 fuerza a número
    });

    const bulkInsert10 = async ({ telefono, nombre, msgs, N = 10 }) => {
        const items = (msgs || [])
            .filter(m => m?.message)
            .map(toItem)
            .filter(x => x.text && x.text.trim().length > 0)
            .sort((a, b) => (a.wa_timestamp || 0) - (b.wa_timestamp || 0))
            .slice(-N);

        if (!items.length) return;

        await axios.post("http://localhost:4000/api/conversaciones/bulk-insert-mensajes", {
            host: hostPhone,        // <—
            telefono,
            nombre,
            origen: "whatsapp-sync",
            items
        });
    };

    if (sesiones[cliente_id]) return sesiones[cliente_id];

    const basePath = `./sessions`;
    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath);

    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${cliente_id}`);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "warn" }),
        browser: Browsers.macOS("Desktop"),
        syncFullHistory: true,                    // intenta traer historial
        shouldSyncHistoryMessage: () => true,     // 🔑 asegura procesar history
        markOnlineOnConnect: false,
        // printQRInTerminal: true,               // deprecado, manejamos abajo
    });

    // ✅ History inicial más confiable
    sock.ev.on("messaging-history.set", async ({ chats, messages, contacts, isLatest }) => {
        // 1) Mapa de nombres desde contacts
        const contactName = new Map();
        for (const c of contacts || []) {
            const n = c.verifiedName || c.name || c.notify || c.pushName || c.short || null;
            if (n) contactName.set(c.id, n);
        }

        // 2) Mapa meta de chats (para acceder a name/subject/pushName después)
        const chatMeta = new Map();
        for (const ch of (chats || [])) {
            const jid = ch.id;
            if (!jid?.endsWith("@s.whatsapp.net")) continue;
            chatMeta.set(jid, {
                name: ch.name || null,
                subject: ch.subject || null,
                pushName: ch.pushName || null,
            });
        }

        // 3) Upsert de conversaciones con nombre “bueno”
        for (const ch of chats || []) {
            const jid = ch.id;
            if (!jid?.endsWith("@s.whatsapp.net")) continue;
            const tel = jid.split("@")[0];

            const nombre = resolveDisplayName({
                jid,
                contactNameMap: contactName,
                chatMetaMap: chatMeta,
                msgPushName: null, // acá todavía no usamos mensaje
            });

            await axios.post("http://localhost:4000/api/conversaciones/upsert", {
                host: hostPhone,        // <- teléfono del negocio
                telefono: tel,          // <- del cliente
                origen: "whatsapp-sync",
                nombre
            }).catch(e => console.error("❌ upsert conversación:", tel, e.message));
        }

        // 4) Agrupar mensajes por jid
        const byJid = new Map();
        for (const m of messages || []) {
            const jid = m.key?.remoteJid;
            if (!jid || !jid.endsWith("@s.whatsapp.net")) continue;
            if (!byJid.has(jid)) byJid.set(jid, []);
            byJid.get(jid).push(m);
        }

        // 5) Para cada jid, resolvemos nombre (usando pushName si existe) y mandamos últimos 10
        for (const [jid, msgs] of byJid.entries()) {
            const tel = jid.split("@")[0];

            // si alguno de los mensajes trae pushName, nos quedamos con el último no-numérico
            const pushFromMsgs = msgs.map(m => m.pushName).filter(Boolean).reverse()
                .find(n => !isNumberLike(n)) || null;

            const nombre = resolveDisplayName({
                jid,
                contactNameMap: contactName,
                chatMetaMap: chatMeta,
                msgPushName: pushFromMsgs
            });

            await bulkInsert10({ telefono: tel, nombre, msgs, N: 10 });
        }
    });


    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log(`🔑 QR para ${cliente_id}:`, qr);
            qrs[cliente_id] = qr;
        }

        if (connection === "open") {
            console.log("✅ WA conectado:", cliente_id);
            // ya no esperamos timeout: el history llegará por messaging-history.set
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut || reason === 401) {
                console.log(`❌ ${cliente_id} cerró sesión o fue removido desde otro dispositivo.`);
                const dir = `./sessions/${cliente_id}`;
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
                delete qrs[cliente_id];
                delete sesiones[cliente_id];
            } else {
                console.log(`🔁 Reintentando conexión para ${cliente_id}...`);
                delete sesiones[cliente_id];
                iniciarSesion(cliente_id);
            }
        }
    });

    // Mensajes en vivo (queda igual)
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages?.[0];
        if (!msg?.message) return;

        if (msg.key.remoteJid === 'status@broadcast' || msg.broadcast) return;

        // filtrar mensajes “protocol” (history sync, etc.)
        const isProtocol = !!msg.message?.protocolMessage;
        const body =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";

        // si no hay texto y no te interesa media, salí
        if (!body || isProtocol) return;

        const ctx = {
            from: msg.key.remoteJid.split("@")[0],
            body:
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                "",
            name: msg.pushName || "Sin nombre",
            host: cliente_id,
            key: msg.key,
            message: msg.message.conversation,
        };

        try {
            const response = await axios.post("http://localhost:4000/api/whatsapp", {
                host: ctx.host,
                from: ctx.from,
                message: ctx.body,
                name: ctx.name,
                fromMe: !!msg.key.fromMe 
            });
            console.log("🧾 Backend (NO enviada aún):", response.data);
        } catch (error) {
            console.error("❌ Error reenviando:", error.message);
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
