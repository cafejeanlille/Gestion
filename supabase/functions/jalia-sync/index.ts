// Fonction planifiée : lit le "CA du jour (encaissé)" depuis la base Firebase
// Realtime Database que le backoffice Jalia utilise pour son tableau "Temps réel",
// et le pousse dans la ligne sync_store('cafe-jean') lue par l'application
// (DATA.jaliaSync).
//
// Comment ça marche :
//   1. On se connecte au backoffice Jalia (session cookie classique) pour
//      récupérer la page "Temps réel" de l'établissement, qui contient un
//      identifiant Firebase dédié à l'établissement (embarqué par Jalia
//      lui-même dans le HTML : window.firebaseSettings).
//   2. On s'authentifie à ce compte Firebase via l'API REST Identity Toolkit.
//   3. On lit /users/{userId} pour obtenir le "realtimeID" de l'établissement,
//      puis /realtimes/{realtimeID} qui contient la session de caisse en cours,
//      avec son tableau total_payments (un total par mode de paiement, en
//      centimes).
//
// Secrets requis (Project Settings > Edge Functions > Secrets) :
//   JALIA_EMAIL, JALIA_PASSWORD : identifiants du compte Jalia du café (pour
//                                 l'étape 1 uniquement).
//   CRON_SECRET                : jeton partagé vérifié via l'en-tête x-cron-secret,
//                                pour que seul notre job planifié puisse déclencher
//                                cette fonction (verify_jwt est désactivé ici).
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectés automatiquement.

const JALIA_BASE = 'https://backoffice.jalia.fr';
const ESTABLISHMENT_ID = '13629';
const SYNC_ROW_ID = 'cafe-jean';

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractCookies(res: Response, jar: Map<string, string>) {
  const headersAny = res.headers as unknown as { getSetCookie?: () => string[] };
  const setCookies = typeof headersAny.getSetCookie === 'function'
    ? headersAny.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx > -1) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function loginJaliaEtRecupererPageLive(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>();

  const loginPageRes = await fetch(`${JALIA_BASE}/fr/session/index`);
  extractCookies(loginPageRes, jar);
  const loginPageHtml = await loginPageRes.text();
  const tokenMatch = loginPageHtml.match(/name="authenticity_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Jeton CSRF introuvable sur la page de connexion Jalia (le site a peut-etre change).');
  const authenticityToken = decodeHtmlEntities(tokenMatch[1]);

  const body = new URLSearchParams({
    utf8: '✓',
    authenticity_token: authenticityToken,
    email,
    password,
    commit: 'connexion',
  });

  const loginRes = await fetch(`${JALIA_BASE}/fr/session/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(jar),
    },
    body: body.toString(),
  });
  extractCookies(loginRes, jar);

  if (loginRes.status !== 302 && loginRes.status !== 303) {
    throw new Error('Echec de connexion Jalia (statut ' + loginRes.status + ') - identifiants invalides ou site change.');
  }

  const pageRes = await fetch(`${JALIA_BASE}/fr/dashboard/establishment/${ESTABLISHMENT_ID}/live`, {
    headers: { Cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  if (pageRes.status >= 300 && pageRes.status < 400) {
    throw new Error('Session Jalia non authentifiee (redirige vers la connexion, statut ' + pageRes.status + ').');
  }
  return await pageRes.text();
}

interface FirebaseSettings {
  apiKey: string;
  databaseURL: string;
  email: string;
  password: string;
}

function extraireFirebaseSettings(html: string): FirebaseSettings {
  const grab = (key: string) => {
    const m = html.match(new RegExp(key + ':\\s*"([^"]*)"'));
    return m ? m[1] : '';
  };
  const settings = {
    apiKey: grab('apiKey'),
    databaseURL: grab('databaseURL'),
    email: grab('email'),
    password: grab('password'),
  };
  if (!settings.apiKey || !settings.databaseURL || !settings.email || !settings.password) {
    throw new Error('Config Firebase introuvable dans la page Jalia (window.firebaseSettings) - structure du site probablement modifiee.');
  }
  return settings;
}

async function authFirebase(settings: FirebaseSettings): Promise<{ idToken: string; localId: string }> {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${settings.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: settings.email, password: settings.password, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error('Authentification Firebase echouee (' + res.status + ').');
  const json = await res.json();
  return { idToken: json.idToken, localId: json.localId };
}

async function lireRealtimeDb(databaseURL: string, path: string, idToken: string): Promise<any> {
  const res = await fetch(`${databaseURL}${path}.json?auth=${idToken}`);
  if (!res.ok) throw new Error(`Lecture Firebase ${path} echouee (${res.status}).`);
  return await res.json();
}

interface Encaissements {
  total: number;
  totalEspeces: number;
  totalCarte: number;
}

function extraireEncaissements(realtimeData: any): Encaissements | null {
  if (!realtimeData || typeof realtimeData !== 'object') return null;
  const sessions = Object.values(realtimeData) as any[];
  const session = sessions.find((s) => s && s.is_live) || sessions[0];
  if (!session || !Array.isArray(session.total_payments) || !Array.isArray(session.tickets)) return null;

  let totalEspeces = 0;
  let totalCarte = 0;
  for (const p of session.total_payments) {
    const montant = (typeof p.amount === 'number' ? p.amount : 0) / 100;
    if (p.type === 'Espèces') totalEspeces += montant;
    else totalCarte += montant;
  }

  // "Total" = toutes les commandes (payées ou non), comme le champ "Total" de
  // la page Jalia "Temps réel" - inclut donc les additions pas encore réglées,
  // contrairement à total_payments qui ne compte que l'argent déjà encaissé.
  let total = 0;
  for (const ticket of session.tickets) {
    if (ticket.cancelled) continue;
    for (const item of (ticket.items || [])) {
      if (item.cancelled) continue;
      const prixUnitaire = (item.price && typeof item.price.amount === 'number') ? item.price.amount : 0;
      const quantite = typeof item.quantity === 'number' ? item.quantity : 1;
      total += prixUnitaire * quantite;
    }
  }
  total = total / 100;

  return {
    total: Math.round(total * 100) / 100,
    totalEspeces: Math.round(totalEspeces * 100) / 100,
    totalCarte: Math.round(totalCarte * 100) / 100,
  };
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return new Response(JSON.stringify({ ok: false, error: 'Non autorise' }), { status: 401 });
  }

  try {
    const email = Deno.env.get('JALIA_EMAIL');
    const password = Deno.env.get('JALIA_PASSWORD');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!email || !password || !supabaseUrl || !serviceKey) {
      throw new Error('Secrets manquants (JALIA_EMAIL / JALIA_PASSWORD / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    }

    const debug = new URL(req.url).searchParams.get('debug') === '1';

    const pageHtml = await loginJaliaEtRecupererPageLive(email, password);
    const fbSettings = extraireFirebaseSettings(pageHtml);
    const { idToken, localId } = await authFirebase(fbSettings);

    const userNode = await lireRealtimeDb(fbSettings.databaseURL, `/users/${localId}`, idToken);
    const realtimeID = userNode && userNode.realtimeID;
    if (!realtimeID) throw new Error('realtimeID introuvable dans /users/' + localId + '.');

    const realtimeData = await lireRealtimeDb(fbSettings.databaseURL, `/realtimes/${realtimeID}`, idToken);
    const encaissements = extraireEncaissements(realtimeData);

    if (debug) {
      return new Response(JSON.stringify({ realtimeID, encaissements, realtimeData }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!encaissements) {
      throw new Error('Structure total_payments introuvable dans /realtimes/' + realtimeID + ' - relancer avec ?debug=1 pour inspecter.');
    }

    const nowIso = new Date().toISOString();
    const dateDuJour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

    const getRes = await fetch(`${supabaseUrl}/rest/v1/sync_store?id=eq.${SYNC_ROW_ID}&select=data`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!getRes.ok) throw new Error('Lecture sync_store echouee (' + getRes.status + ').');
    const rows = await getRes.json();
    const currentData = (Array.isArray(rows) && rows[0] && rows[0].data) ? rows[0].data : {};

    currentData.jaliaSync = {
      date: dateDuJour,
      totalEspeces: encaissements.totalEspeces,
      totalCarte: encaissements.totalCarte,
      dernierCA: { Total: encaissements.total },
      derniereSyncISO: nowIso,
    };

    const putRes = await fetch(`${supabaseUrl}/rest/v1/sync_store?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{ id: SYNC_ROW_ID, data: currentData, updated_at: nowIso }]),
    });
    if (!putRes.ok) throw new Error('Ecriture sync_store echouee (' + putRes.status + ').');

    return new Response(JSON.stringify({ ok: true, encaissements, syncedAt: nowIso }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
