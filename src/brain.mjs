// src/brain.mjs
import OpenAI from 'openai';

const {
  USE_OPENAI = 'false',
  OPENAI_API_KEY,
  LLM_MODEL = 'gpt-4o-mini'
} = process.env;

const openai = (USE_OPENAI === 'true' && OPENAI_API_KEY)
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

export async function think({ text, name, phone }) {
  // Si no hay OpenAI, devolvemos algo seguro
  if (!openai) {
    return {
      reply: "Gracias por tu mensaje. ¿En qué puedo ayudarte?",
      intent: "general_info",
      entities: {},
      want_appointment: false
    };
  }

  const system = `
Eres el asistente de WhatsApp del Dr. Luis Javier González Rangel (GBC, Pachuca).
Responde breve, claro, cálido, sin diagnósticos personalizados por chat.
Precios fijos: consulta $1200 (≈90 min). Cirugía: manga desde $70,000; bypass desde $85,000 (se confirma en consulta).
Dirección: Torre Plétora Urban Center (2º piso), Pachuca. Tel 771 733 0123.
Si detectas datos de triage (edad/peso/estatura/enfermedades), extráelos.
Si el usuario parece querer cita, indícalo.
Devuelve SOLO JSON con esta forma:
{
  "reply": "texto de respuesta",
  "intent": "one of: general_info | location | prices | bariatric_triage | book_appointment | other_gi | not_offered | human",
  "entities": { "age": number|null, "weight_kg": number|null, "height_cm": number|null, "diseases": string[] },
  "want_appointment": boolean,
  "confirm_appointment": "yes"|"no"|null,
  "slot_choice_index": number|null
}
  `.trim();

  const user = `Paciente: ${name || 'desconocido'} (${phone})
Mensaje: """${text}"""`;

  const resp = await openai.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    max_tokens: 400
  });

  try {
    const j = JSON.parse(resp.choices?.[0]?.message?.content || "{}");
    // sanea
    j.entities ??= {};
    j.entities.diseases = Array.isArray(j.entities.diseases) ? j.entities.diseases : [];
    return j;
  } catch {
    return {
      reply: "Gracias por tu mensaje. ¿En qué puedo ayudarte?",
      intent: "general_info",
      entities: {},
      want_appointment: false
    };
  }
}
