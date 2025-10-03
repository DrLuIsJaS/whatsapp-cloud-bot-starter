// src/extract.mjs
import OpenAI from 'openai';

const {
  USE_OPENAI = 'false',
  OPENAI_API_KEY,
} = process.env;

// Reutilizamos OpenAI si hay clave; si no, haremos un fallback regex
const openai = (USE_OPENAI === 'true' && OPENAI_API_KEY)
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// Fallback súper tolerante por regex (peso/estatura/edad) en español
function regexExtract(text) {
  const t = (text || '').toLowerCase().replace(',', '.');

  const edad = (() => {
    // busca primero “xx años” o “edad xx”
    const m1 = t.match(/(\d{1,2})\s*a[nñ]os/);
    const m2 = t.match(/edad[:\s]*([0-9]{1,2})/);
    const m3 = t.match(/\b([1-9]\d)\b/); // 10-99 suelto
    return +(m1?.[1] || m2?.[1] || m3?.[1] || 0) || null;
  })();

  const peso = (() => {
    // números seguidos de kg o “peso xx”
    const m1 = t.match(/([0-9]{2,3}(?:\.[0-9])?)\s*kg/);
    const m2 = t.match(/peso[:\s]*([0-9]{2,3}(?:\.[0-9])?)/);
    // Si el texto contiene dos números de 2-3 dígitos, suele ser peso/estatura
    if (m1) return +m1[1];
    if (m2) return +m2[1];
    const nums = (t.match(/([0-9]{2,3}(?:\.[0-9])?)/g) || []).map(Number);
    if (nums.length >= 2) return nums[0];
    return null;
  })();

  const estatura = (() => {
    // “170 cm”, “1.70 m”, “estatura 165”, “mido 1.65”
    const m1 = t.match(/([1-2][0-9]{2})\s*cm/);         // 150-299 cm
    const m2 = t.match(/([0-2](?:\.[0-9]{1,2}))\s*m/);  // 1.50 m
    const m3 = t.match(/estatura[:\s]*([1-2][0-9]{2})/);
    const m4 = t.match(/mido\s*([1-2](?:\.[0-9]{1,2}))/);
    if (m1) return +m1[1];
    if (m2) return Math.round(+m2[1] * 100);
    if (m3) return +m3[1];
    if (m4) return Math.round(+m4[1] * 100);

    // Si detectamos dos números y ya asignamos peso al 1º, el 2º suele ser estatura en cm
    const nums = (t.match(/([0-9]{2,3}(?:\.[0-9])?)/g) || []).map(Number);
    if (nums.length >= 2) {
      const maybe = Math.round(nums[1]); // 165
      if (maybe >= 130 && maybe <= 220) return maybe;
    }
    return null;
  })();

  // Enfermedades básicas frecuentes
  const enf = [];
  const dict = [
    'diabetes','hipertensi', 'hipotiroid', 'tiroid', 'apnea', 'hígado graso', 'higado graso',
    'reflujo','gastritis','colitis','asma','dislipidemia','artritis','depresi','ansiedad'
  ];
  dict.forEach(k => { if (t.includes(k)) enf.push(k); });

  return { age: edad, weight_kg: peso, height_cm: estatura, diseases: Array.from(new Set(enf)) };
}

export async function extractPatientData(text) {
  // Si no hay OpenAI, usa regex pura
  if (!openai) return { from: 'regex', ...regexExtract(text) };

  try {
    // Pedimos JSON estricto
    const system = `Eres un extractor de datos clínicos para triage bariátrico en español.
Devuelve SOLO JSON con las claves: age (entero en años o null), weight_kg (número o null), height_cm (número entero en cm o null), diseases (array de strings, puede ser []).
Acepta texto libre con medidas en "m" o "cm" y peso con o sin "kg".`;
    const user = `Extrae del siguiente texto:\n"""${text}"""`;

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      max_tokens: 200
    });
    const content = resp.choices?.[0]?.message?.content || '{}';
    const j = JSON.parse(content);

    // Rellenamos con regex si algo falta
    const reg = regexExtract(text);
    return {
      from: 'openai+regex',
      age: j.age ?? reg.age ?? null,
      weight_kg: j.weight_kg ?? reg.weight_kg ?? null,
      height_cm: j.height_cm ?? reg.height_cm ?? null,
      diseases: Array.isArray(j.diseases) ? j.diseases : reg.diseases
    };
  } catch (e) {
    console.error('extractPatientData error:', e);
    return { from: 'regex-fallback', ...regexExtract(text) };
  }
}
