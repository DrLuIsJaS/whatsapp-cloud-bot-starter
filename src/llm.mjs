import OpenAI from 'openai';

const {
  USE_OPENAI = 'false',
  OPENAI_API_KEY,
  LLM_MODEL = 'gpt-4o-mini',
  FALLBACK_REPLY = 'Gracias por tu mensaje. ¿En qué puedo ayudarte?'
} = process.env;

let openai = null;
if (USE_OPENAI === 'true' && OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

export async function responderConIA({ text, from, name }) {
  try {
    if (!openai) return FALLBACK_REPLY;

    const system = [
      "Eres el asistente de WhatsApp del Dr. Luis Javier González Rangel (Gastro Bariatric Center, Pachuca).",
      "Responde breve, claro y profesional. Sin diagnósticos ni tratamientos personalizados por chat; invita a consulta.",
      "Políticas: urgencias -> aconseja acudir a urgencias / 911. No inventes precios fuera de los que se proporcionan. Mantén tono cálido.",
      "Datos fijos: Consulta $1200 MXN (≈90 min). Dirección: Torre Plétora Urban Center (2º piso), Pachuca. Tel 771 733 0123."
    ].join(' ');

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Nombre: ${name || 'desconocido'}; Tel: ${from}; Mensaje: ${text}` }
    ];

    const resp = await openai.chat.completions.create({
      model: LLM_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 220
    });
    return resp.choices?.[0]?.message?.content?.trim() || FALLBACK_REPLY;
  } catch (e) {
    console.error('LLM error:', e);
    return FALLBACK_REPLY;
  }
}
