// Fonction appelée pour l'extraction automatique de documents (factures d'achat,
// tickets de caisse / relevés Z, listes de stock) : le café prend une photo ou
// dépose un PDF/fichier, l'IA renvoie les lignes structurées à relire avant
// validation manuelle.
//
// Utilise l'API Mistral (gratuite à l'inscription sur console.mistral.ai, comme
// pour l'assistant réseaux sociaux et les recettes de cocktail) plutôt que
// l'API Anthropic (payante, plus utilisée ici faute de crédit sur le compte).
// Le nom "claude-extract" reste pour ne pas casser les appels déjà en place côté
// front-end, mais la fonction n'utilise plus Claude.
//
// Le front-end envoie {system, messages} au format Anthropic Messages (blocs
// "image"/"document"/"text") — cette fonction les convertit au format Mistral :
// - image -> bloc "image_url" (Pixtral, modèle avec vision)
// - document (PDF) -> passage par l'OCR Mistral pour en extraire le texte, qui
//   remplace le bloc (un modèle texte suffit alors)
// - text -> inchangé
// et renvoie la réponse dans la même forme que l'API Anthropic ({content:
// [{type:'text', text}]}) pour que le front-end n'ait rien à changer.
//
// Secret requis (Project Settings > Edge Functions > Secrets), déjà configuré
// pour les autres fonctions IA du café :
//   MISTRAL_API_KEY : clé API Mistral, créée sur https://console.mistral.ai

const MISTRAL_MODEL_VISION = 'pixtral-12b-2409';
const MISTRAL_MODEL_TEXTE = 'mistral-small-latest';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

type BlocAnthropic =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };

// Extrait le texte d'un PDF via l'OCR Mistral (un modèle texte suffit ensuite).
async function ocrPdf(apiKey: string, mediaType: string, data: string): Promise<string> {
  const res = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mistral-ocr-latest',
      document: { type: 'document_url', document_url: `data:${mediaType};base64,${data}` },
    }),
  });
  const data_ = await res.json();
  if (!res.ok) {
    throw new Error(data_?.message || `Echec de l'OCR du PDF (${res.status})`);
  }
  const pages = Array.isArray(data_.pages) ? data_.pages : [];
  return pages.map((p: any) => p.markdown || '').join('\n\n').trim();
}

// Convertit les blocs de contenu au format Anthropic (envoyés par le front-end)
// vers le format Mistral, en passant les PDF par l'OCR au passage.
async function convertirBlocs(apiKey: string, blocs: BlocAnthropic[]) {
  const out: any[] = [];
  let aUneImage = false;
  for (const b of blocs) {
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && b.source?.type === 'base64') {
      out.push({ type: 'image_url', image_url: `data:${b.source.media_type};base64,${b.source.data}` });
      aUneImage = true;
    } else if (b.type === 'document' && b.source?.type === 'base64') {
      const texte = await ocrPdf(apiKey, b.source.media_type, b.source.data);
      out.push({ type: 'text', text: texte || '(PDF vide ou illisible)' });
    }
  }
  return { blocs: out, aUneImage };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Methode non supportee' }, 405);
  }

  try {
    const apiKey = Deno.env.get('MISTRAL_API_KEY');
    if (!apiKey) {
      throw new Error('MISTRAL_API_KEY non configuree (Project Settings > Edge Functions > Secrets).');
    }

    const body = await req.json().catch(() => ({}));
    const system = typeof body.system === 'string' ? body.system : '';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const premierMessage = messages[0];

    if (!system || !premierMessage || !Array.isArray(premierMessage.content)) {
      return jsonResponse({ error: 'Requete invalide (system/messages manquants).' }, 400);
    }

    const { blocs, aUneImage } = await convertirBlocs(apiKey, premierMessage.content);
    const model = aUneImage ? MISTRAL_MODEL_VISION : MISTRAL_MODEL_TEXTE;

    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        // Le mode JSON forcé n'est pas fiable avec les modèles vision : on
        // s'appuie sur la consigne du prompt et on nettoie la réponse ensuite.
        ...(aUneImage ? {} : { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: blocs },
        ],
      }),
    });

    const mistralJson = await mistralRes.json();
    if (!mistralRes.ok) {
      const message = mistralJson?.message || `Appel Mistral echoue (${mistralRes.status})`;
      return jsonResponse({ error: message }, mistralRes.status);
    }

    const texte = (mistralJson?.choices?.[0]?.message?.content || '').trim();

    // Réponse dans la même forme que l'API Anthropic, lue telle quelle par le
    // front-end (data.content.map(b => b.text)).
    return jsonResponse({ content: [{ type: 'text', text: texte }] });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
