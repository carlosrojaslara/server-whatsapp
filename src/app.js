import "dotenv/config";
import express from "express";
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { iniciarSesion, qrs, getSesion } from './sessionManager.js';
import QRCode from 'qrcode';

const app = express();
app.use(express.json());
//app.use(cors());

const PORT = process.env.PORT ?? 3010;

app.delete('/session/:telefono', (req, res) => {
  const telefono = req.params.telefono;
  const dir = path.resolve(`./sessions/${telefono}`);

  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`🧹 Sesión eliminada para ${telefono}`);
    return res.json({ mensaje: 'Sesión eliminada correctamente' });
  } else {
    return res.status(404).json({ error: 'No existe sesión para ese número' });
  }
});

// ✅ Iniciar sesión y generar QR
app.post('/v1/init', async (req, res) => {
    const { cliente_id } = req.body;
    if (!cliente_id) return res.status(400).json({ error: "Falta cliente_id" });

    await iniciarSesion(cliente_id);
    res.json({ status: "pending", message: `Escaneá el QR en /qr/${cliente_id}` });
});

// ✅ Mostrar QR como HTML con imagen incrustada
app.get('/qr/:cliente_id', async (req, res) => {
    const qr = qrs[req.params.cliente_id];
    if (!qr) return res.status(404).send("QR no disponible aún");

    const qrImage = await QRCode.toDataURL(qr);
    res.send(`
        <html>
          <body style="text-align:center;font-family:sans-serif">
            <h2>Escaneá el código con WhatsApp</h2>
            <img src="${qrImage}" width="300" height="300" />
          </body>
        </html>
    `);
});

app.get('/qr-img/:cliente_id', async (req, res) => {
    const qr = qrs[req.params.cliente_id];
    if (!qr) return res.status(404).send("QR no disponible aún");

    const qrImage = await QRCode.toBuffer(qr);
    res.setHeader("Content-Type", "image/png");
    res.send(qrImage);
});

app.post('/v1/enviar', async (req, res) => {
  const { cliente_id, telefono, texto } = req.body;

  if (!cliente_id || !telefono || !texto) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  
  try {
    const sock = getSesion(cliente_id);
    if (!sock) {
      return res.status(404).json({ error: "Sesión no activa para ese cliente_id" });
    }
    
    console.log("🔁 Enviando mensaje a:", telefono, "| Mensaje:", texto);
    const jid = `${telefono}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: texto });

    res.json({ success: true, mensaje: "Mensaje enviado por WhatsApp" });
  } catch (error) {
    console.error("❌ Error enviando mensaje por WhatsApp:", error.message);
    res.status(500).json({ error: "Error enviando mensaje" });
  }
});

// ✅ Levantar servidor
app.listen(PORT, () => {
    console.log(`✅ Servidor iniciado en http://localhost:${PORT}`);
});