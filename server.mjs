import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { responderConIA } from './src/llm.mjs';
import { listFreeSlots, createTentativeEvent } from './src/calendar.mjs';
import { createClient } from '@supabase/supabase-js';
import { extractPatientData } from './src/extract.mjs';

const app = express();
app.use(express.json({ verify: (req, res, buf)=>{ req.rawBody = buf } }));

const env = process.env;
const supa = (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE)
  ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE)
  : null;

function bmi(weightKg, heightCm){
  const h = (heightCm||0)/100;
  if (!h) return null;
  return +(weightKg / (h*h)).toFixed(1);
}

function intent(text){
  const t = (text||'').toLowerCase();
  if (/(ubicaci[oó]n|direcci[oó]n|ple[t|u]ora|zona plateada|donde)/.test(t)) return 'ubicacion';
  if (/(cita|agendar|valoraci[oó]n|horario|disponibilidad)/.test(t)) return 'cita';
  if (/(costo|precio|cu[aá]nto)/.test(t)) return 'precios';
  if (/(manga|bypass|bal[oó]n|bari[aá]tric|obesidad)/.test(t)) return 'bariatria';
  if (/(ves[ií]cula|colecist|hernia|reflujo|acalasia|gastritis|colitis|apendic)/.test(t)) return 'gi';
  if (/(cpre|endoscop|diarrea cr[oó]nica)/.test(t)) return 'no-servicio';
  if (/(humano|asesor|recepci[oó]n)/.test(t)) return 'humano';
  return null;
}

const sesiones = new Map();

async function logMsg({ wa_id, name, direction, body }){
  if (!supa) return;
  await supa.from('conversations').upsert({ wa_id, name }).select();
  await supa.from('messages').insert({ wa_id, direction, body });
}

function verifySignature(req){
  try{
    if (!env.APP_SECRET) return true;
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return false;
    const expected = 'sha256='+crypto.createHmac('sha256', env.APP_SECRET).update(req.rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }catch{ return false; }
}

app.get('/', (_req,res)=> res.json({ ok:true, service:'gbc-whatsapp-bot-pro' }));

app.get('/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === env.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', async (req,res)=>{
  try{
    if (!verifySignature(req)) return res.sendStatus(403);

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const name = value?.contacts?.[0]?.profile?.name;
    const type = msg.type;
    let text = '';
    if (type === 'text') text = msg.text?.body || '';
    else if (type==='interactive' && msg.interactive?.type==='button_reply') text = msg.interactive.button_reply?.title || '';
    else if (type==='interactive' && msg.interactive?.type==='list_reply') text = msg.interactive.list_reply?.title || '';
    else text = `[${type}]`;

    await logMsg({ wa_id: from, name, direction:'in', body: text });

    // Urgencias
    if (/(urgencia|emergencia|sangrado|dolor intenso|fiebre alta)/i.test(text)){
      await sendText(from, "Si es una urgencia, por favor acude a urgencias o llama al 911.");
      return res.sendStatus(200);
    }

    let out = null;
    const i = intent(text);

    // Config agenda
    const tz = env.CALENDAR_TIMEZONE || 'America/Mexico_City';
    const slotMinutes = +(env.CALENDAR_SLOT_MINUTES||30);
    const workStart = env.CALENDAR_WORK_START || '09:00';
    const workEnd = env.CALENDAR_WORK_END || '18:00';
    const lookDays = +(env.CALENDAR_LOOKAHEAD_DAYS||14);

    // Sesión por contacto
    const s = sesiones.get(from) || { flujo:null, paso:0, datos:{} };
    function reset(){ s.flujo=null; s.paso=0; s.datos={}; sesiones.set(from, s); }

    // Ramas directas
    if (i==='ubicacion'){
      out = "Estamos en **GBC Gastro Bariatric Center**, Torre Plétora Urban Center (2º piso), Pachuca.";
    } else if (i==='precios'){
      out = "Consulta de valoración: **$1200 MXN** (~90 min). Cirugía depende del procedimiento: **manga desde $70,000** y **bypass desde $85,000**. Se confirma en consulta.";
    } else if (i==='no-servicio'){
      out = "No realizamos **CPRE, endoscopias** ni manejo de **diarrea crónica**. Podemos orientarte con un centro especializado.";
    } else if (i==='gi'){
      out = "Atendemos vesícula, hernias (inguinal/umbilical/hiato), reflujo, acalasia, gastritis y colitis. ¿Deseas agendar **valoración** ($1200 MXN, 90 min)?";
      s.flujo='cita'; s.paso=0; sesiones.set(from, s);
    } else if (i==='bariatria'){
      // Inicia triage bariátrico flexible (texto libre)
      s.flujo='bariatria'; s.paso=0; sesiones.set(from, s);
      out = "Perfecto. Para orientarte mejor, cuéntame en tus palabras: **edad**, **peso** y **estatura** (como gustes), y si tienes alguna **enfermedad** (diabetes, hipertensión, etc.).";
    } else if (i==='cita'){
      s.flujo='cita'; s.paso=0; sesiones.set(from, s);
      out = "Perfecto. ¿Cuál es tu **nombre completo** para agendar?";
    } else if (i==='humano'){
      out = "Con gusto te comunico con un asesor humano. ¿Prefieres mensaje por WhatsApp o llamada?";
    } 
    // === Flujo Bariatría (extractor inteligente) ===
    else if (s.flujo==='bariatria'){
      if (s.paso===0){
        s.paso = 1; sesiones.set(from, s);
        out = "Perfecto. Para orientarte mejor, cuéntame en tus palabras: **edad**, **peso** y **estatura** (como gustes), y si tienes alguna **enfermedad** (diabetes, hipertensión, etc.).";
      } else {
        // Extrae datos de texto libre con OpenAI+regex (si hay IA) o solo regex
        const prev = s.datos || {};
        const ex = await extractPatientData(text);
        s.datos = {
          edad: prev.edad ?? ex.age ?? null,
          peso: prev.peso ?? ex.weight_kg ?? null,
          estatura: prev.estatura ?? ex.height_cm ?? null,
          enfermedades: Array.isArray(prev.enfermedades) && prev.enfermedades.length ? prev.enfermedades : (ex.diseases || [])
        };
        sesiones.set(from, s);

        const faltan = [];
        if (!s.datos.edad) faltan.push('edad');
        if (!s.datos.peso) faltan.push('peso');
        if (!s.datos.estatura) faltan.push('estatura');

        if (faltan.length){
          const p = faltan.join(', ').replace(/, ([^,]*)$/, ' y $1');
          out = `Gracias. Me falta **${p}**. Puedes decirlo como quieras (ej. "tengo 38, peso 112 kg y mido 1.68").`;
        } else {
          const imc = bmi(s.datos.peso, s.datos.estatura);
          s.datos.imc = imc;
          if (imc && imc >= 30){
            out = `Tu **IMC es ${imc}**. Con IMC ≥30, **sí podrías ser candidato** a cirugía bariátrica.\n` +
                  `Seguimos un **protocolo prequirúrgico** con valoración del equipo multidisciplinario para definir el mejor procedimiento.\n` +
                  `¿Deseas **agendar una valoración** ($1200 MXN, ~90 min) para resolver dudas y planear tu tratamiento?`;
            // Saltamos a flujo de cita
            s.flujo='cita'; s.paso=0; sesiones.set(from, s);
          } else if (imc) {
            out = `Tu **IMC es ${imc}**. Con IMC <30, opciones como **balón** o **medicamentos** ayudan cuando hay ~10–15 kg sobre el ideal, pero **no tienen la potencia** de la cirugía para normalizar peso.\n` +
                  `Si lo deseas, podemos ver manejo no quirúrgico o **agendar valoración** para revisar tu caso.`;
          } else {
            out = "No pude calcular tu IMC. ¿Me confirmas peso en kg y estatura en cm o en metros? (Ej. 112 kg y 1.68 m)";
          }
        }
      }
    } 
    // === Flujo Citas (Google Calendar) ===
    else if (s.flujo==='cita'){
      if (s.paso===0){
        s.datos.nombre = text.trim();
        s.paso=1; sesiones.set(from, s);
        const slots = await listFreeSlots({ days: parseInt(lookDays), tz, slotMinutes, workStart, workEnd }).catch(()=>[]);
        if (!slots.length) out = "No encuentro horarios libres en las próximas semanas. ¿Propones fecha/hora y te confirmamos?";
        else {
          s.datos.slots = slots;
          const lista = slots.map((x,i)=>`${i+1}) ${x.label}`).join('\n');
          out = "Horarios disponibles (responde con el número):\n"+lista;
        }
      } else if (s.paso===1){
        const idx = parseInt(text.trim())-1;
        const slots = s.datos.slots||[];
        if (isNaN(idx)||idx<0||idx>=slots.length) out = "Responde con el **número** del horario elegido.";
        else { s.datos.elegido = slots[idx]; s.paso=2; sesiones.set(from, s); out = `¿Confirmas tu cita para **${slots[idx].label}**? (sí/no)`; }
      } else if (s.paso===2){
        if (/^s[ií]/i.test(text)){
          try{
            await createTentativeEvent({
              startISO: s.datos.elegido.iso,
              minutes: slotMinutes,
              summary: `Valoración GBC - ${s.datos.nombre}`,
              description: `Cita solicitada por WhatsApp. Paciente: ${s.datos.nombre}.`
            });
            out = "¡Listo! Dejé tu cita en **tentativa**. Te confirmamos por este medio.";
          }catch(e){
            console.error('Calendar insert error:', e);
            out = "No pude registrar la cita ahora mismo. ¿Te contactamos para confirmarla?";
          }
          reset();
        } else { reset(); out = "Sin problema. ¿Quieres ver otros horarios o que te contactemos?"; }
      }
    }

    // Minifaq por keywords si no hubo respuesta aún
    if (!out){
      const t = (text||'').toLowerCase();
      if (/manga|sleeve/.test(t)) out = "La **manga gástrica** reduce el tamaño del estómago; requiere evaluación integral. ¿Deseas agendar valoración ($1200 MXN, 90 min)?";
      else if (/bypass/.test(t)) out = "El **bypass gástrico** favorece pérdida de peso y control metabólico. ¿Agendamos valoración?";
    }

    // IA como último recurso
    if (!out) out = await responderConIA({ text, from, name });

    await sendText(from, out);
    await logMsg({ wa_id: from, name, direction:'out', body: out });
    return res.sendStatus(200);
  }catch(e){
    console.error('Webhook error:', e);
    return res.sendStatus(200);
  }
});

async function sendText(to, body){
  const url = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product:'whatsapp', to, type:'text', text:{ body: body.slice(0,4096) } };
  const r = await fetch(url, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok){
    const tx = await r.text();
    console.error('Error enviando mensaje:', r.status, tx);
  }
}

/* ===== Admin UI & APIs ===== */
function requireAuth(req,res,next){
  const auth = req.headers.authorization || '';
  const [typ, cred] = auth.split(' ');
  if (typ!=='Basic') return res.set('WWW-Authenticate','Basic').status(401).end();
  const [u,p] = Buffer.from(cred||'', 'base64').toString().split(':');
  if (u===process.env.BASIC_AUTH_USER && p===process.env.BASIC_AUTH_PASS) return next();
  return res.set('WWW-Authenticate','Basic').status(401).end();
}

app.get('/api/conversations', requireAuth, async (_req,res)=>{
  if (!supa) return res.json([]);
  const { data } = await supa.from('conversations').select('*').order('created_at', { ascending:false });
  res.json(data||[]);
});

app.get('/api/messages', requireAuth, async (req,res)=>{
  if (!supa) return res.json([]);
  const wa_id = req.query.wa_id;
  const { data } = await supa.from('messages').select('*').eq('wa_id', wa_id).order('ts', { ascending:true });
  res.json(data||[]);
});

app.post('/api/send', requireAuth, express.json(), async (req,res)=>{
  try{
    const { wa_id, body } = req.body;
    await sendText(wa_id, body);
    await logMsg({ wa_id, name:null, direction:'out', body });
    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.get('/admin', requireAuth, (_req,res)=>{
  res.type('html').send(`
<!doctype html><meta charset="utf-8">
<title>Inbox GBC</title>
<style>
body{font-family:system-ui,Segoe UI,Arial;margin:0;display:grid;grid-template-columns:280px 1fr;height:100vh}
aside{border-right:1px solid #eee;padding:12px;overflow:auto}
main{display:grid;grid-template-rows:1fr auto;height:100vh}
#msgs{padding:12px;overflow:auto;background:#fafafa}
#send{display:flex;border-top:1px solid #eee}
textarea{flex:1;padding:10px;border:0;outline:0}
button{padding:10px 16px}
.bubble{max-width:70%;padding:8px 12px;border-radius:14px;margin:6px 0;white-space:pre-wrap}
.in{background:#f1f5f9}
.out{background:#dbeafe;margin-left:auto}
.conv{cursor:pointer;padding:8px;border-radius:8px;margin:6px 0}
.conv:hover{background:#f8fafc}
h3{margin:0 0 8px 0}
</style>
<aside>
  <h3>Conversaciones</h3>
  <div id="list"></div>
</aside>
<main>
  <div id="msgs"></div>
  <div id="send">
    <textarea id="txt" rows="2" placeholder="Escribe una respuesta..."></textarea>
    <button onclick="send()">Enviar</button>
  </div>
</main>
<script>
let sel=null, creds=btoa('${process.env.BASIC_AUTH_USER||"admin"}:${process.env.BASIC_AUTH_PASS||"admin"}');
async function q(u){return fetch(u,{headers:{Authorization:'Basic '+creds}}).then(r=>r.json())}
async function post(u,body){return fetch(u,{method:'POST',headers:{Authorization:'Basic '+creds,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json())}
async function loadConvs(){
  const c=await q('/api/conversations'); const L=document.getElementById('list'); L.innerHTML='';
  c.forEach(x=>{ const d=document.createElement('div'); d.className='conv'; d.textContent=(x.name||x.wa_id); d.onclick=()=>loadMsgs(x.wa_id); L.appendChild(d); });
}
async function loadMsgs(wa){
  sel=wa; const m=await q('/api/messages?wa_id='+wa); const M=document.getElementById('msgs'); M.innerHTML='';
  m.forEach(x=>{ const b=document.createElement('div'); b.className='bubble '+x.direction; b.textContent=x.body; M.appendChild(b); });
  M.scrollTop=M.scrollHeight;
}
async function send(){
  if(!sel) return alert('Selecciona una conversación');
  const t=document.getElementById('txt'); const v=t.value.trim(); if(!v) return;
  const r=await post('/api/send',{ wa_id: sel, body: v }); if(!r.ok) return alert('Error enviando');
  t.value=''; await loadMsgs(sel);
}
loadConvs();
</script>
  `);
});

app.listen(process.env.PORT||3000, ()=> console.log('✅ GBC bot escuchando en :'+(process.env.PORT||3000)));
