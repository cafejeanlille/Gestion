// Fonction planifiée : lit le "CA du jour (encaissé)" et le "CA cumulé du mois"
// (espèces + carte) depuis le backoffice Jalia, et les pousse dans la ligne
// sync_store('cafe-jean') lue par l'application (DATA.jaliaSync /
// DATA.jaliaCumulMois).
//
// Comment ça marche :
//   1. On se connecte au backoffice Jalia (session cookie classique).
//   2. Pour "aujourd'hui" (caisse en cours, pas encore clôturée) : la page
//      "Temps réel" embarque un identifiant Firebase dédié à l'établissement
//      (window.firebaseSettings) qui donne accès en direct à la session de
//      caisse (Realtime Database) avec le détail des paiements.
//   3. Pour le reste du mois (caisses déjà clôturées) : on lit la liste des
//      caisses (/tills) et le détail de chaque caisse (/dashboard/till/{id})
//      qui contient les "Modes de paiements" (Espèces / Carte de crédit). Ces
//      jours sont mis en cache (DATA.jaliaTillsCache) pour ne pas les
//      re-télécharger à chaque exécution planifiée.
//
// Secrets requis (Project Settings > Edge Functions > Secrets) :
//   JALIA_EMAIL, JALIA_PASSWORD : identifiants du compte Jalia du café.
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

async function loginJalia(email: string, password: string): Promise<Map<string, string>> {
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

  return jar;
}

async function fetchAuthed(jar: Map<string, string>, path: string): Promise<string> {
  const res = await fetch(`${JALIA_BASE}${path}`, {
    headers: { Cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error('Session Jalia non authentifiee (redirige vers la connexion) sur ' + path + '.');
  }
  return await res.text();
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

interface TillListEntry {
  tillId: string;
  date: string; // YYYY-MM-DD (date de début de service)
}

const MOIS_FR: Record<string, string> = {
  'janv': '01', 'févr': '02', 'fevr': '02', 'mars': '03', 'avr': '04', 'mai': '05', 'juin': '06',
  'juil': '07', 'août': '08', 'aout': '08', 'sept': '09', 'oct': '10', 'nov': '11', 'déc': '12', 'dec': '12',
};

function parseDateTillFr(texte: string): string | null {
  // ex: "Mercredi 22 Juil 2026 de 13:37 à 01:18"
  const m = texte.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]{3,4})\.?\s+(\d{4})/);
  if (!m) return null;
  const jour = m[1].padStart(2, '0');
  const moisTxt = m[2].toLowerCase().replace('.', '');
  const mois = MOIS_FR[moisTxt];
  if (!mois) return null;
  return `${m[3]}-${mois}-${jour}`;
}

function listerTills(html: string): TillListEntry[] {
  const entries: TillListEntry[] = [];
  const re = /href="\/fr\/dashboard\/till\/(\d+)"[^>]*>([^<]*)</g;
  const parDate = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tillId = m[1];
    const texte = decodeHtmlEntities(m[2]);
    const date = parseDateTillFr(texte);
    if (date && !parDate.has(tillId)) parDate.set(tillId, date);
  }
  for (const [tillId, date] of parDate) entries.push({ tillId, date });
  return entries;
}

interface DetailTill {
  especes: number;
  carte: number;
}

function extraireMontantSpans(html: string, labelRegex: string): number | null {
  // Les montants sont eclates sur plusieurs <span> (ex: <span>52</span><span>,</span><span>50</span>)
  const re = new RegExp(labelRegex + '[\\s\\S]{0,300}?<span[^>]*>(\\d+)</span>\\s*<span[^>]*>,</span>\\s*<span[^>]*>(\\d+)</span>', 'i');
  const m = html.match(re);
  if (!m) return null;
  const n = parseFloat(`${m[1]}.${m[2]}`);
  return isNaN(n) ? null : n;
}

function extraireDetailTill(html: string): DetailTill | null {
  const especes = extraireMontantSpans(html, 'Esp[eè]ces');
  const carte = extraireMontantSpans(html, 'Carte de cr[eé]dit');
  if (especes === null && carte === null) return null;
  return {
    especes: especes ?? 0,
    carte: carte ?? 0,
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
    const debugTills = new URL(req.url).searchParams.get('debug') === 'tills';
    const debugTillId = new URL(req.url).searchParams.get('tillId');

    const jar = await loginJalia(email, password);

    if (debugTillId) {
      const detailHtml = await fetchAuthed(jar, `/fr/dashboard/till/${debugTillId}`);
      return new Response(JSON.stringify({ detail: extraireDetailTill(detailHtml) }), { headers: { 'Content-Type': 'application/json' } });
    }

    const pageHtml = await fetchAuthed(jar, `/fr/dashboard/establishment/${ESTABLISHMENT_ID}/live`);
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
    const moisCourant = dateDuJour.slice(0, 7);

    const tillsListHtml = await fetchAuthed(jar, `/fr/dashboard/establishment/${ESTABLISHMENT_ID}/tills`);
    const tillsDuMois = listerTills(tillsListHtml).filter((t) => t.date.slice(0, 7) === moisCourant && t.date !== dateDuJour);

    if (debugTills) {
      return new Response(JSON.stringify({ tillsListHtmlLength: tillsListHtml.length, tillsDuMois }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const getRes = await fetch(`${supabaseUrl}/rest/v1/sync_store?id=eq.${SYNC_ROW_ID}&select=data`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!getRes.ok) throw new Error('Lecture sync_store echouee (' + getRes.status + ').');
    const rows = await getRes.json();
    const currentData = (Array.isArray(rows) && rows[0] && rows[0].data) ? rows[0].data : {};

    const cache: Record<string, DetailTill & { tillId: string }> = currentData.jaliaTillsCache || {};
    for (const till of tillsDuMois) {
      if (cache[till.date] && cache[till.date].tillId === till.tillId) continue;
      const detailHtml = await fetchAuthed(jar, `/fr/dashboard/till/${till.tillId}`);
      const detail = extraireDetailTill(detailHtml);
      if (detail) cache[till.date] = { ...detail, tillId: till.tillId };
    }
    // Nettoyage : ne garder que le mois courant et le mois precedent (evite de grossir indefiniment)
    const moisPrecedent = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date(new Date().setMonth(new Date().getMonth() - 1))).slice(0, 7);
    for (const date of Object.keys(cache)) {
      if (!date.startsWith(moisCourant) && !date.startsWith(moisPrecedent)) delete cache[date];
    }
    currentData.jaliaTillsCache = cache;

    let especesMois = encaissements.totalEspeces;
    let carteMois = encaissements.totalCarte;
    for (const [date, detail] of Object.entries(cache)) {
      if (date.startsWith(moisCourant)) {
        especesMois += detail.especes;
        carteMois += detail.carte;
      }
    }

    currentData.jaliaSync = {
      date: dateDuJour,
      totalEspeces: encaissements.totalEspeces,
      totalCarte: encaissements.totalCarte,
      dernierCA: { Total: encaissements.total },
      derniereSyncISO: nowIso,
    };

    currentData.jaliaCumulMois = {
      mois: moisCourant,
      especes: Math.round(especesMois * 100) / 100,
      carte: Math.round(carteMois * 100) / 100,
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

    return new Response(JSON.stringify({ ok: true, encaissements, cumulMois: currentData.jaliaCumulMois, syncedAt: nowIso }), {
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
