// Fonction appelée depuis l'onglet "Réseaux sociaux" de l'app.
//
// Le visuel (cadre Art Déco, rayons, médaillon "Café Jean", adresse...) est un
// gabarit FIXE construit ici en code : il est rigoureusement identique à chaque
// génération, quel que soit le format. On y insère soit un seul événement (outil
// "Créateur de visuel", formats Story/Publication) soit une liste de plusieurs
// événements (outil "Programme du mois", format Affiche) — le titre et la
// date/heure de chaque événement sont saisis directement par le café, PAS
// générés par l'IA : ce qui est tapé est exactement ce qui s'affiche.
//
// L'IA (Mistral) n'intervient que pour UNE chose : écrire la légende
// Instagram/Facebook du "Créateur de visuel", à partir du titre/de la date/
// heure et d'un brief libre optionnel. Le "Programme du mois" n'a pas de
// légende et n'appelle donc jamais l'IA.
//
// L'IA ne publie rien : le café copie le texte et télécharge l'image générée,
// et publie lui-même sur Instagram/Facebook.
//
// Secret requis (Project Settings > Edge Functions > Secrets) :
//   MISTRAL_API_KEY : clé API Mistral, créée sur https://console.mistral.ai
//
// verify_jwt reste activé (comportement par défaut) : l'appel doit inclure
// l'API key Supabase (apikey / Authorization Bearer), comme tous les autres
// appels que fait déjà l'app à Supabase.

const MISTRAL_MODEL = 'mistral-small-latest';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FORMATS: Record<string, { w: number; h: number }> = {
  story: { w: 1080, h: 1920 },
  publication: { w: 1080, h: 1080 },
  affiche: { w: 1080, h: 1350 },
};

const PALETTE = {
  vert: '#0C2118',
  vertClair: '#173D2A',
  or: '#C9A668',
  creme: '#F3ECDD',
};

const IDENTITE = {
  adresseMajuscules: '117 BIS RUE DES POSTES, LILLE',
  quartierVille: 'Wazemmes · Lille',
  kicker: 'DEPUIS 1923',
};

const SYSTEM_PROMPT_LEGENDE = `Tu es Jean, le patron du café-bar "Café Jean" (117 bis rue des Postes, Lille,
quartier Wazemmes, depuis 1923 — vintage, chaleureux, jamais aseptisé ni "startup", compte
Instagram @cafejeanlille). C'est TOI qui écris ce post, vite fait sur ton téléphone entre deux
clients — pas un community manager, pas une agence.

Écris UNE SEULE légende Instagram/Facebook (pas plusieurs versions au choix) pour la
publication décrite par le café ci-dessous (titre, date/heure et détails éventuels) :
- Écris comme tu parles vraiment, pas comme une pub. Familier, direct, sans afféterie.
- Phrases courtes. Une seule phrase peut suffire. Pas besoin de tout développer.
- Interdiction absolue des formules toutes faites : "on vous attend avec impatience",
  "n'hésitez pas à venir nous voir", "découvrez", "profitez de", "plongez dans l'univers de",
  "une expérience unique", "petits et grands", etc. Si tu sens que ça sonne "pub", tu changes.
- Pas de point d'exclamation partout — une phrase sur deux au grand maximum, souvent aucun.
- Emoji : quasiment jamais. Zéro la plupart du temps, un seul si vraiment ça sonne naturel.
- Pas de hashtags du tout — le café ne veut aucune suggestion de hashtag, juste le texte.
- Ne cite JAMAIS le nom, l'adresse ou le compte Instagram d'un établissement réel autre que
  "Café Jean", même si un autre bar/café du quartier ou de la rue semble correspondre au sujet.

Réponds UNIQUEMENT avec un JSON strict, sans texte autour, de cette forme exacte (un seul
élément dans "captions") :
{"captions":[{"texte":"..."}]}`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function echapperHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Rayons dorés façon soleil levant, partant du centre géométrique exact du cadre —
// calculés en coordonnées réelles (pas un viewBox carré générique), donc jamais
// décalés ni déformés quel que soit le format (carré, portrait, très haut).
function rayons(w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const rayon = Math.sqrt(w * w + h * h);
  const n = 20;
  let out = '';
  for (let i = 0; i < n; i++) {
    const angle = (i * 360) / n;
    const rad = (angle * Math.PI) / 180;
    const x2 = cx + rayon * Math.cos(rad);
    const y2 = cy + rayon * Math.sin(rad);
    out += `<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${PALETTE.or}" stroke-width="1.2" opacity="0.16"/>`;
  }
  return out;
}

// Éventail de traits fins dans un coin, façon Art Déco.
function eventailCoin(x: number, y: number, angles: number[], longueur: number): string {
  let out = '';
  for (const angle of angles) {
    const rad = (angle * Math.PI) / 180;
    const x2 = x + longueur * Math.cos(rad);
    const y2 = y + longueur * Math.sin(rad);
    out += `<line x1="${x}" y1="${y}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${PALETTE.or}" stroke-width="1.3" opacity="0.55"/>`;
  }
  return out;
}

// Frise festonnée (petite vague de demi-cercles) le long d'un bord horizontal,
// façon Art Déco. sweep=1 fait bomber la vague vers le bas, sweep=0 vers le haut
// (toujours orientée vers le centre du visuel, quel que soit le bord).
function friseFestons(xDebut: number, xFin: number, y: number, sweep: 0 | 1, r = 14): string {
  let d = `M ${xDebut} ${y}`;
  for (let x = xDebut; x + 2 * r <= xFin; x += 2 * r) {
    d += ` A ${r} ${r} 0 0 ${sweep} ${x + 2 * r} ${y}`;
  }
  return `<path d="${d}" fill="none" stroke="${PALETTE.or}" stroke-width="2" opacity="0.8"/>`;
}

// Même frise festonnée, mais le long d'un bord VERTICAL (gauche/droite) —
// même logique de sweep, toujours orientée vers le centre du visuel.
function friseFestonsVerticale(yDebut: number, yFin: number, x: number, sweep: 0 | 1, r = 14): string {
  let d = `M ${x} ${yDebut}`;
  for (let y = yDebut; y + 2 * r <= yFin; y += 2 * r) {
    d += ` A ${r} ${r} 0 0 ${sweep} ${x} ${y + 2 * r}`;
  }
  return `<path d="${d}" fill="none" stroke="${PALETTE.or}" stroke-width="2" opacity="0.8"/>`;
}

// Petit losange décoratif, posé sur un coin du cadre.
function diamantCoin(x: number, y: number, taille = 11): string {
  return `<rect x="${x - taille / 2}" y="${y - taille / 2}" width="${taille}" height="${taille}" fill="${PALETTE.or}" opacity="0.75" transform="rotate(45 ${x} ${y})"/>`;
}

function decorSvg(w: number, h: number): string {
  const marge1 = 16;
  const marge2 = 22;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;inset:0;z-index:0" xmlns="http://www.w3.org/2000/svg">
    ${rayons(w, h)}
    <rect x="${marge1}" y="${marge1}" width="${w - marge1 * 2}" height="${h - marge1 * 2}" fill="none" stroke="${PALETTE.or}" stroke-width="1.5"/>
    <rect x="${marge2}" y="${marge2}" width="${w - marge2 * 2}" height="${h - marge2 * 2}" fill="none" stroke="${PALETTE.or}" stroke-width="1"/>
    ${eventailCoin(marge1, marge1, [15, 35, 55, 75], 56)}
    ${eventailCoin(w - marge1, marge1, [105, 125, 145, 165], 56)}
    ${eventailCoin(w - marge1, h - marge1, [195, 215, 235, 255], 56)}
    ${eventailCoin(marge1, h - marge1, [285, 305, 325, 345], 56)}
    ${friseFestons(70, w - 70, 34, 1)}
    ${friseFestons(70, w - 70, h - 34, 0)}
    ${friseFestonsVerticale(90, h - 90, 34, 0)}
    ${friseFestonsVerticale(90, h - 90, w - 34, 1)}
    ${diamantCoin(marge1, marge1)}
    ${diamantCoin(w - marge1, marge1)}
    ${diamantCoin(w - marge1, h - marge1)}
    ${diamantCoin(marge1, h - marge1)}
  </svg>`;
}

type Evenement = { titre: string; dateHeure: string | null };

// Bloc pour un seul événement (Créateur de visuel : Story / Publication).
function blocEvenementUnique(titre: string | null, dateHeure: string | null): string {
  const titreLigne = titre
    ? `<div style="font-family:'Playfair Display',serif;font-weight:700;font-size:44px;line-height:1.15;color:${PALETTE.or};text-align:center;text-shadow:0 2px 10px rgba(0,0,0,0.35);">${echapperHtml(titre)}</div>`
    : '';
  const dateLigne = dateHeure
    ? `<div style="font-family:'IBM Plex Mono',monospace;font-size:19px;letter-spacing:2px;color:${PALETTE.creme};text-transform:uppercase;text-align:center;">${echapperHtml(dateHeure)}</div>`
    : '';
  return titreLigne + dateLigne;
}

// Bloc pour plusieurs événements (Programme du mois : Affiche).
function blocEvenementsMultiples(evenements: Evenement[]): string {
  const items = evenements
    .slice(0, 8)
    .map((e) => {
      const date = e.dateHeure
        ? ` <span style="color:${PALETTE.or};font-family:'IBM Plex Mono',monospace;font-size:16px;letter-spacing:1px;">— ${echapperHtml(e.dateHeure)}</span>`
        : '';
      return `<div style="font-family:'Cormorant Garamond',serif;font-style:italic;font-size:24px;color:${PALETTE.creme};text-align:center;line-height:1.4;">${echapperHtml(e.titre)}${date}</div>`;
    })
    .join('');
  return `<div style="display:flex;flex-direction:column;gap:16px;align-items:center;">${items}</div>`;
}

// Gabarit fixe du visuel Café Jean : cadre Art Déco, rayons et médaillon toujours
// identiques ; seul le bloc "événement(s)" (texte fourni directement par le café)
// varie selon l'outil (un seul événement, ou une liste pour le programme du mois).
function construireVisuelHtml(w: number, h: number, blocEvenement: string): string {
  const ratio = h / w;
  const justify = ratio >= 1.5 ? 'space-between' : 'center';
  return `<div style="position:relative;width:${w}px;height:${h}px;overflow:hidden;background:linear-gradient(135deg, ${PALETTE.vert}, ${PALETTE.vertClair});font-family:'Playfair Display',serif;">
    ${decorSvg(w, h)}
    <div style="position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:${justify};padding:80px 70px;box-sizing:border-box;gap:28px;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:21px;letter-spacing:4px;color:${PALETTE.creme};">${IDENTITE.kicker}</div>
      <div style="width:406px;height:406px;border-radius:50%;border:1px solid rgba(201,166,104,0.6);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <div style="width:380px;height:380px;border-radius:50%;border:1.5px solid ${PALETTE.or};display:flex;flex-direction:column;align-items:center;justify-content:center;">
          <div style="font-size:52px;font-weight:700;color:${PALETTE.creme};letter-spacing:1px;text-shadow:0 2px 8px rgba(0,0,0,0.35);">CAFÉ</div>
          <div style="font-size:52px;font-weight:700;color:${PALETTE.or};letter-spacing:1px;text-shadow:0 2px 8px rgba(0,0,0,0.35);">JEAN</div>
        </div>
      </div>
      ${blocEvenement}
      <div style="font-family:'IBM Plex Mono',monospace;font-size:17px;letter-spacing:2px;color:${PALETTE.creme};text-align:center;">${IDENTITE.adresseMajuscules}</div>
      <div style="font-family:'Cormorant Garamond',serif;font-style:italic;font-size:28px;color:${PALETTE.or};text-align:center;">${IDENTITE.quartierVille}</div>
    </div>
  </div>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Methode non supportee' }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const formatCle = typeof body.format === 'string' && FORMATS[body.format] ? body.format : 'publication';
    const { w, h } = FORMATS[formatCle];

    // Programme du mois : une liste de plusieurs événements, pas de légende, pas d'IA.
    const evenementsBruts = Array.isArray(body.evenements) ? body.evenements : null;
    if (evenementsBruts) {
      const evenements: Evenement[] = evenementsBruts
        .filter((e: any) => e && typeof e.titre === 'string' && e.titre.trim())
        .map((e: any) => ({
          titre: e.titre.trim(),
          dateHeure: typeof e.dateHeure === 'string' && e.dateHeure.trim() ? e.dateHeure.trim() : null,
        }));
      if (!evenements.length) {
        return jsonResponse({ ok: false, error: 'Ajoutez au moins un événement avec un titre.' }, 400);
      }
      const visuelHtml = construireVisuelHtml(w, h, blocEvenementsMultiples(evenements));
      return jsonResponse({ ok: true, captions: [], visuelHtml, format: formatCle, largeur: w, hauteur: h });
    }

    // Créateur de visuel : un seul événement, saisi directement (titre/dateHeure),
    // avec une légende écrite par l'IA à partir de ces infos + un brief optionnel.
    const titre = typeof body.titre === 'string' && body.titre.trim() ? body.titre.trim() : null;
    const dateHeure = typeof body.dateHeure === 'string' && body.dateHeure.trim() ? body.dateHeure.trim() : null;
    const brief = typeof body.brief === 'string' ? body.brief.trim() : '';

    if (!titre && !brief) {
      return jsonResponse({ ok: false, error: 'Renseignez au moins un titre ou une description.' }, 400);
    }

    const visuelHtml = construireVisuelHtml(w, h, blocEvenementUnique(titre, dateHeure));

    let captions: { texte: string }[] = [];
    const apiKey = Deno.env.get('MISTRAL_API_KEY');
    if (apiKey) {
      const infosPublication = [
        titre ? `Titre : ${titre}` : null,
        dateHeure ? `Date/heure : ${dateHeure}` : null,
        brief ? `Détails donnés par le café : ${brief}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_LEGENDE },
            { role: 'user', content: infosPublication },
          ],
        }),
      });

      if (mistralRes.ok) {
        const mistralJson = await mistralRes.json();
        const texte = (mistralJson?.choices?.[0]?.message?.content || '').trim();
        try {
          const jsonMatch = texte.match(/\{[\s\S]*\}/);
          const resultat = JSON.parse(jsonMatch ? jsonMatch[0] : texte);
          if (Array.isArray(resultat.captions)) captions = resultat.captions;
        } catch {
          // Pas de légende cette fois, le visuel reste généré normalement.
        }
      }
    }

    return jsonResponse({ ok: true, captions, visuelHtml, format: formatCle, largeur: w, hauteur: h });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: (err as Error).message }, 500);
  }
});
