// Fonction appelée pour l'extraction automatique de documents (factures d'achat,
// tickets de caisse / relevés Z, listes de stock) via la vision de Claude
// (Anthropic) : le café prend une photo ou dépose un PDF/fichier, l'IA renvoie
// les lignes structurées à relire avant validation manuelle.
//
// Remplace l'ancienne fonction Netlify "/.netlify/functions/claude-extract" (le
// site Netlify a été supprimé, tout passe maintenant par GitHub Pages + Supabase).
// Reçoit {system, messages} exactement au format de l'API Anthropic Messages tel
// que déjà construit côté front-end (image/PDF en base64 ou texte), ajoute juste
// le modèle et max_tokens, et renvoie la réponse Anthropic brute — le front-end
// lit directement data.content, sans changement nécessaire de son côté.
//
// Secret requis (Project Settings > Edge Functions > Secrets) :
//   ANTHROPIC_API_KEY : clé API Anthropic, créée sur https://console.anthropic.com

const ANTHROPIC_MODEL = 'claude-sonnet-5';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Methode non supportee' }, 405);
  }

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY non configuree (Project Settings > Edge Functions > Secrets).');
    }

    const body = await req.json().catch(() => ({}));
    const system = typeof body.system === 'string' ? body.system : '';
    const messages = Array.isArray(body.messages) ? body.messages : [];

    if (!system || !messages.length) {
      return jsonResponse({ error: 'Requete invalide (system/messages manquants).' }, 400);
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system,
        messages,
      }),
    });

    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      const message = data?.error?.message || `Appel Anthropic echoue (${anthropicRes.status})`;
      return jsonResponse({ error: message }, anthropicRes.status);
    }

    return jsonResponse(data);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
