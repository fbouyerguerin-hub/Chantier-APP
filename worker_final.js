/**
 * Cloudflare Worker — EBP → Baserow Sync
 * Guérin Bâtiments
 * 
 * Périmètre : commandes fournisseurs depuis le 01/09/2026
 * Sync toutes les 30 min (cron) + bouton manuel (/sync)
 * Répertoire : clients + fournisseurs EBP → Baserow (/sync-contacts, + cron)
 * Articles   : catalogue EBP (table Item) → KV du Worker (/sync-articles, + cron)
 *              recherche /articles/search?q=… et /articles/get?codes=… (clé APP_KEY)
 */

const EBP_AUTH_URL     = "https://api-login.ebp.com/connect/authorize";
const EBP_TOKEN_URL    = "https://api-login.ebp.com/connect/token";
const EBP_API_BASE     = "https://api-developpeurs.ebp.com/batiment/api/v1";
const EBP_SCOPE        = "openid profile email offline_access";
const TOKEN_KV_KEY     = "ebp_tokens";
const BASEROW_TABLE_CF = "1179060"; // Commandes Fournisseurs
const BASEROW_TABLE_LI = "1179061"; // Commandes Fournisseurs Lignes
const BASEROW_TABLE_CH = "1014441"; // Chantiers
const BASEROW_TABLE_CC = "1210899"; // Commandes Clients
const BASEROW_TABLE_LC = "1210908"; // Commandes Clients Lignes
const FIELD_NUM_CMD    = "field_10630609"; // ID champ "Numero commande" dans Baserow
const DATE_DEBUT       = "2026-09-01T00:00:00";
const DATE_DEBUT_CLIENTS = "2025-01-01T00:00:00"; // resynchro complète commandes clients (?full=1)
const LAST_SYNC_KEY    = "last_sync_date";
const LAST_SYNC_KEY_CLIENTS = "last_sync_date_clients";
const BASEROW_TABLE_REP = "2442130"; // ⚠️ ID de la table Baserow « Répertoire » (clients + fournisseurs EBP)
const LAST_SYNC_KEY_REPERTOIRE = "last_sync_date_repertoire";
// ✅ Confirmé par test le 21/09/2026 : DocumentType 4 = Commandes clients (préfixe "CM")
const DOCUMENT_TYPE_CMD_CLIENT = "4";

// Champs entête à synchroniser depuis EBP (les autres sont préservés)
const CHAMPS_EBP_ENTETE = [
  "Numero commande", "Date commande", "Fournisseur", "Chantier",
  "Numero chantier", "Designation", "Montant total HT", "Montant total TVA",
  "Net a payer", "Numero devis", "Reference complete", "Envoye par mail",
  "Date reception prevue"
];

// Champs entête à synchroniser depuis EBP pour une commande CLIENT
// (adapter aux noms réels de vos champs Baserow si différents)
const CHAMPS_EBP_ENTETE_CLIENT = [
  "Numero commande", "Date commande", "Client", "Chantier",
  "Numero chantier", "Designation", "Montant HT", "Reference complete",
];

// ============================================================
// EXPORT PRINCIPAL
// ============================================================
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Key",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/health") return json({ status: "ok", version: "v7.3" }, cors);
      if (url.pathname === "/auth")   return handleAuth(url, env);
      if (url.pathname === "/auth/callback") return handleCallback(url, env);
      // Toutes les autres routes (synchros, catalogue, diagnostic) exigent la clé
      // APP_KEY : en-tête X-App-Key (appli) ou ?key=… (test depuis un navigateur).
      // /health, /auth et /auth/callback restent ouvertes (connexion OAuth EBP).
      if (!env.APP_KEY) return json({ error: "APP_KEY non configurée sur le Worker" }, cors, 503);
      if (!cleAppValide(request, url, env)) return json({ error: "Accès refusé (clé APP_KEY manquante ou invalide)" }, cors, 401);
      if (url.pathname === "/sync") {
        const updateDate = url.searchParams.get("updateDate") !== "0";
        const test = url.searchParams.get("test") === "1";
        return json(await sync(env, updateDate, test), cors);
      }
      if (url.pathname === "/sync-clients") {
        const updateDate = url.searchParams.get("updateDate") !== "0";
        const test = url.searchParams.get("test") === "1";
        const typeOverride = url.searchParams.get("type") || null;
        const full = url.searchParams.get("full") === "1"; // resynchronise tout depuis DATE_DEBUT
        return json(await syncClients(env, updateDate, test, typeOverride, full), cors);
      }
      if (url.pathname === "/sync-contacts") {
        const full = url.searchParams.get("full") === "1"; // relit tous les tiers EBP
        const test = url.searchParams.get("test") === "1"; // aperçu des champs EBP, aucune écriture
        return json(await syncRepertoire(env, { full, test }), cors);
      }
      if (url.pathname === "/articles/search" || url.pathname === "/articles/get") {
        const cat = await lireCatalogue(env);
        if (url.pathname === "/articles/search") {
          const limite = Math.min(100, parseInt(url.searchParams.get("limit")) || 30);
          return json({ maj: cat.maj, total: cat.items.length, results: rechercherCatalogue(cat, url.searchParams.get("q") || "", limite) }, cors);
        }
        const codes = new Set((url.searchParams.get("codes") || "").split(",").map(c => c.trim()).filter(Boolean));
        return json({ results: cat.items.filter(x => codes.has(x.c)).map(cataloguePublic) }, cors);
      }
      if (url.pathname === "/sync-articles") {
        const full = url.searchParams.get("full") === "1"; // relit toute la table Item
        const test = url.searchParams.get("test") === "1"; // aperçu des champs EBP, aucune écriture
        const restart = url.searchParams.get("restart") === "1"; // abandonne un import complet en cours et repart de zéro
        const pages = Math.max(1, Math.min(20, parseInt(url.searchParams.get("pages")) || ART_PAGES_PAR_APPEL));
        return json(await syncArticles(env, { full, test, restart, pages }), cors);
      }
      // ⚠️ TEMPORAIRE (découverte du champ statut chantier dans EBP) — à supprimer ensuite.
      // Ex : /ebp-test?path=ConstructionSites  → 2 premiers enregistrements, toutes clés visibles.
      if (url.pathname === "/ebp-test") {
        const path = url.searchParams.get("path") || "";
        if (!/^[A-Za-z]+(\/[A-Za-z]+)*$/.test(path)) return json({ error: "path invalide" }, cors, 400);
        const extra = new URLSearchParams(url.searchParams);
        extra.delete("path");
        const token = await getToken(env);
        const r = await fetch(
          `${EBP_API_BASE}/Folders/${env.EBP_FOLDER_ID}/${path}${extra.toString() ? "?" + extra.toString() : ""}`,
          { headers: { "Authorization": `Bearer ${token}`, "ebp-subscription-key": env.EBP_SUBSCRIPTION_KEY } }
        );
        const txt = await r.text();
        let data; try { data = JSON.parse(txt); } catch { return json({ http: r.status, brut: txt.slice(0, 1500) }, cors); }
        const liste = data.results || data.value || (Array.isArray(data) ? data : [data]);
        return json({ http: r.status, total: liste.length, apercu: liste.slice(0, 2) }, cors);
      }
      return json({ error: "Route inconnue" }, cors, 404);
    } catch (e) {
      return json({ error: e.message }, cors, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Exécution séquentielle : le refresh token EBP est à usage unique,
    // deux appels simultanés à getToken() pourraient l'invalider.
    ctx.waitUntil((async () => {
      try { await sync(env); } catch (e) { console.error("sync:", e.message); }
      try { await syncRepertoire(env); } catch (e) { console.error("syncRepertoire:", e.message); }
      try { await syncArticles(env, { pages: 2 }); } catch (e) { console.error("syncArticles:", e.message); }
    })());
  }
};

// ============================================================
// AUTH EBP
// ============================================================
function handleAuth(url, env) {
  const params = new URLSearchParams({
    client_id: env.EBP_CLIENT_ID, redirect_uri: env.EBP_REDIRECT_URI,
    response_type: "code", scope: EBP_SCOPE, state: crypto.randomUUID(),
  });
  return Response.redirect(`${EBP_AUTH_URL}?${params}`, 302);
}

async function handleCallback(url, env) {
  const code = url.searchParams.get("code");
  if (!code) return new Response("Code manquant", { status: 400 });
  const body = new URLSearchParams({
    grant_type: "authorization_code", client_id: env.EBP_CLIENT_ID,
    client_secret: env.EBP_CLIENT_SECRET, redirect_uri: env.EBP_REDIRECT_URI, code,
  });
  const r = await fetch(EBP_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) return new Response(`Erreur token : ${await r.text()}`, { status: 500 });
  const tokens = await r.json();
  await env.EBP_TOKENS.put(TOKEN_KV_KEY, JSON.stringify({
    access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    expiry: Date.now() + (tokens.expires_in - 60) * 1000,
  }));
  return new Response(`<html><body style="font-family:sans-serif;padding:40px">
    <h2>✅ Authentification EBP réussie !</h2>
    <p><a href="/sync">🔄 Synchroniser maintenant</a></p>
  </body></html>`, { headers: { "Content-Type": "text/html" } });
}

async function getToken(env) {
  const stored = await env.EBP_TOKENS.get(TOKEN_KV_KEY);
  if (!stored) throw new Error("Pas de token — visite /auth");
  const data = JSON.parse(stored);
  if (Date.now() < data.expiry) return data.access_token;
  // Refresh
  const body = new URLSearchParams({
    grant_type: "refresh_token", client_id: env.EBP_CLIENT_ID,
    client_secret: env.EBP_CLIENT_SECRET, refresh_token: data.refresh_token,
  });
  const r = await fetch(EBP_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error("Token expiré — revisite /auth");
  const tokens = await r.json();
  await env.EBP_TOKENS.put(TOKEN_KV_KEY, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || data.refresh_token,
    expiry: Date.now() + (tokens.expires_in - 60) * 1000,
  }));
  return tokens.access_token;
}

// ============================================================
// SYNC PRINCIPALE
// ============================================================
async function sync(env, updateDate = true, test = false) {
  const token = await getToken(env);
  const debut = new Date();
  let nbCrees = 0, nbMaj = 0, nbInchanges = 0, nbLignesCrees = 0, nbLignesMaj = 0, nbLignesSuppr = 0;
  const erreurs = [];

  // 1. Récupération commandes EBP
  const lastSync    = await env.EBP_TOKENS.get(LAST_SYNC_KEY) || DATE_DEBUT;
  const syncStarted = new Date().toISOString();
  const duration = "365";
  // Pour sync manuelle (updateDate=false) : repart 2h en arrière pour ne rien rater
  const sysDate  = updateDate 
    ? lastSync 
    : new Date(new Date(lastSync).getTime() - 2 * 60 * 60 * 1000).toISOString();
  const ebpResp = await fetch(
    `${EBP_API_BASE}/Folders/${env.EBP_FOLDER_ID}/Documents/PurchaseDocument/WithLines?${new URLSearchParams({
      DocumentType: "4",
      Duration: duration,
      SysModifiedDate: sysDate,
    })}`,
    { headers: { "Authorization": `Bearer ${token}`, "ebp-subscription-key": env.EBP_SUBSCRIPTION_KEY } }
  );
  if (!ebpResp.ok) throw new Error(`EBP error ${ebpResp.status}: ${await ebpResp.text()}`);
  const ebpData   = await ebpResp.json();
  const commandes = ebpData.results || ebpData;

  // Mode test : n'écrit rien dans Baserow — sert notamment à identifier le nom exact du
  // champ EBP correspondant à "Réception le" (date de réception prévue), pas encore
  // synchronisé. Appeler /sync?test=1 puis regarder "champs_date_detectes".
  if (test) {
    return {
      status: "test",
      total_ebp: commandes.length,
      apercu: commandes.slice(0, 3).map(c => ({
        DocumentNumber: c.DocumentNumber,
        DocumentDate:   c.DocumentDate,
        SupplierName:   c.SupplierName || c.ThirdPartyName,
        Reference:      c.Reference,
      })),
      cles_premier_document: commandes[0] ? Object.keys(commandes[0]) : [],
      champs_date_detectes: commandes[0]
        ? Object.fromEntries(Object.entries(commandes[0]).filter(([k]) => /date|recept|delivery|livr/i.test(k)))
        : {},
    };
  }

  // 2. Pour chaque commande EBP
  for (const cmd of commandes) {
    const num = cmd.DocumentNumber || "";
    if (!num) continue;

    try {
      // Recherche chantier — plusieurs critères par priorité
      let chantierBaserowId = null;
      const constructionSiteId = cmd.ConstructionSiteId || "";
      const reference          = cmd.Reference || "";

      async function chercherChantier(terme) {
        if (!terme) return null;
        const r = await fetch(
          `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_CH}/?user_field_names=true&size=1&filter__Nom du chantier__contains=${encodeURIComponent(terme)}`,
          { headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } }
        );
        if (!r.ok) return null;
        const d = await r.json();
        return d.results?.length > 0 ? d.results[0].id : null;
      }

      // Priorité 1 : ConstructionSiteId EBP → ex: "CHA01187" → "CH1187"
      if (constructionSiteId) {
        const code = constructionSiteId.replace(/^CHA0*/, "CH");
        chantierBaserowId = await chercherChantier(code);
      }

      // Priorité 2 : Code CH dans la référence → ex: "CH1076"
      if (!chantierBaserowId) {
        const m = reference.match(/CH\d+/i);
        if (m) chantierBaserowId = await chercherChantier(m[0].toUpperCase());
      }

      // Priorité 3 : Code DE dans la référence → ex: "DE6288"
      if (!chantierBaserowId) {
        const m = reference.match(/DE\s*(\d+)/i);
        if (m) chantierBaserowId = await chercherChantier("DE " + m[1]);
        if (!chantierBaserowId && m) chantierBaserowId = await chercherChantier("DE" + m[1]);
      }

      // Priorité 4 désactivée (risque de faux rapprochements)

      // Payload entête (champs EBP uniquement)
      const matchDevis = reference.match(/DE\s*(\d+)/i);
      const numDevis   = matchDevis ? "DE" + matchDevis[1] : "";
      const date       = (cmd.DocumentDate || "").substring(0, 10);

      const payload = {
        "Numero commande":   num,
        "Date commande":     date,
        "Fournisseur":       cmd.SupplierName    || cmd.ThirdPartyName || "",
        "Chantier":          chantierBaserowId ? [chantierBaserowId] : [],
        "Numero chantier":   constructionSiteId,
        "Designation":       reference,
        "Montant total HT":  cmd.AmountVatExcluded  ?? 0,
        "Montant total TVA": cmd.VatAmount            ?? 0,
        "Net a payer":       cmd.TotalDueAmount       ?? 0,
        "Numero devis":      numDevis,
        "Reference complete": reference,
        "Envoye par mail":    cmd.SendedByMail === true,
        // Champ EBP confirmé le 23/09/2026 via /sync?test=1 : "DeliveryDate".
        // Priorité EBP par défaut : une correction manuelle faite dans l'appli (icône ✏️,
        // champ "Date reception prevue") est un ajustement ponctuel qui sera réécrasé par
        // cette valeur dès qu'EBP renvoie une date différente au prochain sync (30 min).
        "Date reception prevue": (cmd.DeliveryDate || "").substring(0, 10),
      };

      // Recherche dans Baserow
      const searchResp = await fetch(
        `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_CF}/?user_field_names=true&size=1&filter__${FIELD_NUM_CMD}__equal=${encodeURIComponent(num)}`,
        { headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } }
      );
      if (!searchResp.ok) throw new Error(`Baserow search error ${searchResp.status}`);
      const searchData = await searchResp.json();

      let baserowRowId = null;

      if (!searchData.results?.length) {
        // Création
        const postR = await fetch(
          `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_CF}/?user_field_names=true`,
          { method: "POST", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload) }
        );
        if (!postR.ok) throw new Error(`Baserow POST error: ${await postR.text()}`);
        baserowRowId = (await postR.json()).id;
        nbCrees++;
      } else {
        const existing = searchData.results[0];
        baserowRowId   = existing.id;

        // Comparaison — ne PATCH que si différence sur les champs EBP
        const diff = {};
        for (const champ of CHAMPS_EBP_ENTETE) {
          if (champ === "Chantier") continue; // traité séparément
          const valEBP     = String(payload[champ] ?? "");
          const valBaserow = String(existing[champ] ?? "");
          if (valEBP !== valBaserow) diff[champ] = payload[champ];
        }
        // Chantier
        const chantierActuel = (existing["Chantier"] || [])[0]?.id || null;
        if (chantierBaserowId !== chantierActuel) {
          diff["Chantier"] = chantierBaserowId ? [chantierBaserowId] : [];
        }

        if (Object.keys(diff).length > 0) {
          await fetch(
            `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_CF}/${baserowRowId}/?user_field_names=true`,
            { method: "PATCH", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify(diff) }
          );
          nbMaj++;
        } else {
          nbInchanges++;
        }
      }

      // Synchronisation des lignes articles
      const lignesEBP = cmd.Lines || cmd.lines || cmd.DocumentLines || [];

      // Récupération lignes existantes dans Baserow
      const lignesResp = await fetch(
        `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LI}/?user_field_names=true&size=200&filter__Commande__link_row_has=${baserowRowId}`,
        { headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } }
      );
      const lignesBaserow = lignesResp.ok ? (await lignesResp.json()).results || [] : [];

      // Map Baserow : Description (50 chars) → ligne
      const mapBaserow = new Map();
      for (const l of lignesBaserow) {
        const desc = (l["Description"] || "").trim().substring(0, 50);
        if (desc && !mapBaserow.has(desc)) mapBaserow.set(desc, l);
      }

      // Set des descriptions EBP
      const descsEBP = new Set(lignesEBP.map(l => (l.DescriptionClear || l.Description || "").trim().substring(0, 50)).filter(Boolean));

      // 1. Supprimer lignes Baserow absentes d'EBP
      for (const [desc, l] of mapBaserow.entries()) {
        if (!descsEBP.has(desc)) {
          await fetch(
            `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LI}/${l.id}/`,
            { method: "DELETE", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } }
          );
          nbLignesSuppr++;
        }
      }

      // 2. Créer ou mettre à jour les lignes EBP — par lots de 20
      // Filtrer lignes vides (sans description ET sans référence)
      // Trier les lignes EBP par LineOrder
      lignesEBP.sort((a, b) => (a.LineOrder || 0) - (b.LineOrder || 0));

      const lignesEBPFiltrees = lignesEBP.filter(l =>
        (l.DescriptionClear || l.Description || "").trim() || (l.ItemId || "").trim()
      );
      const TAILLE_LOT = 20;
      for (let debut = 0; debut < lignesEBPFiltrees.length; debut += TAILLE_LOT) {
        const lot = lignesEBPFiltrees.slice(debut, debut + TAILLE_LOT);
        for (const ligne of lot) {
        const descEBP   = (ligne.DescriptionClear || ligne.Description || "").trim();
        const descCle   = descEBP.substring(0, 50);
        const lignePayload = {
          "Commande":              [baserowRowId],
          "Reference fournisseur": ligne.ItemId          || "",
          "Description":           descEBP,
          "Categorie":             ligne.FamilyCaption   || "",
          "Unite":                 ligne.UnitId          || "",
          "Quantite":              ligne.Quantity        || 0,
          "Debourse HT":           ligne.CostPrice       || 0,
          "Montant HT":            ligne.NetAmountVatExcludedWithDiscount || 0,
          "TVA":                   ligne.VatAmount       || 0,
          "Ordre":                 ligne.LineOrder       || 0,
        };

        const existing = mapBaserow.get(descCle);
        if (!existing) {
          // Création
          const liR = await fetch(
            `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LI}/?user_field_names=true`,
            { method: "POST", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify(lignePayload) }
          );
          if (liR.ok) nbLignesCrees++;
        } else {
          // PATCH seulement si quantité ou prix ont changé
          const diff = {};
          if (String(ligne.Quantity || 0) !== String(existing["Quantite"] || 0)) diff["Quantite"] = ligne.Quantity || 0;
          if (String(ligne.CostPrice || 0) !== String(existing["Debourse HT"] || 0)) diff["Debourse HT"] = ligne.CostPrice || 0;
          if (String(ligne.NetAmountVatExcludedWithDiscount || 0) !== String(existing["Montant HT"] || 0)) diff["Montant HT"] = ligne.NetAmountVatExcludedWithDiscount || 0;
          if (String(ligne.VatAmount || 0) !== String(existing["TVA"] || 0)) diff["TVA"] = ligne.VatAmount || 0;
          if (String(ligne.ItemId || "") !== String(existing["Reference fournisseur"] || "")) diff["Reference fournisseur"] = ligne.ItemId || "";
          if (String(ligne.LineOrder || 0) !== String(existing["Ordre"] || 0)) diff["Ordre"] = ligne.LineOrder || 0;

          if (Object.keys(diff).length > 0) {
            await fetch(
              `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LI}/${existing.id}/?user_field_names=true`,
              { method: "PATCH", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(diff) }
            );
            nbLignesMaj++;
          }
        }
        // Pause entre les lots pour éviter Too many subrequests
        if (debut + TAILLE_LOT < lignesEBPFiltrees.length) {
          await new Promise(r => setTimeout(r, 100));
        }
      } // fin lot
      } // fin boucle lots

    } catch(e) {
      erreurs.push({ num, erreur: e.message });
    }
  }

  // Mettre à jour la date de dernière sync (seulement si demandé)
  if (updateDate) await env.EBP_TOKENS.put(LAST_SYNC_KEY, syncStarted);

  return {
    status:           "ok",
    date:             debut.toISOString(),
    derniere_sync:    lastSync,
    total_ebp:        commandes.length,
    commandes_crees:  nbCrees,
    commandes_maj:    nbMaj,
    commandes_inch:   nbInchanges,
    lignes_crees:     nbLignesCrees,
    lignes_maj:       nbLignesMaj,
    lignes_suppr:     nbLignesSuppr,
    erreurs,
  };
}

// ============================================================
// SYNC COMMANDES CLIENTS (miroir de sync() ci-dessus, pour les ventes)
// ============================================================
async function syncClients(env, updateDate = true, test = false, typeOverride = null, full = false) {
  const token = await getToken(env);
  const debut = new Date();
  let nbCrees = 0, nbMaj = 0, nbInchanges = 0, nbLignesCrees = 0, nbLignesMaj = 0, nbLignesSuppr = 0;
  const erreurs = [];
  const documentType = typeOverride || DOCUMENT_TYPE_CMD_CLIENT;

  const lastSync    = await env.EBP_TOKENS.get(LAST_SYNC_KEY_CLIENTS) || DATE_DEBUT;
  const syncStarted = new Date().toISOString();
  // Mode complet : fenêtre élargie depuis le 01/01/2025 (jours écoulés + marge)
  const duration = full
    ? String(Math.ceil((Date.now() - new Date(DATE_DEBUT_CLIENTS).getTime()) / 86400000) + 30)
    : "365";
  const sysDate  = full
    ? DATE_DEBUT_CLIENTS
    : updateDate
      ? lastSync
      : new Date(new Date(lastSync).getTime() - 2 * 60 * 60 * 1000).toISOString();

  // ⚠️ Endpoint "SaleDocument" et DOCUMENT_TYPE_CMD_CLIENT à confirmer via /sync-clients?test=1&type=X
  const ebpResp = await fetch(
    `${EBP_API_BASE}/Folders/${env.EBP_FOLDER_ID}/Documents/SaleDocument/WithLines?${new URLSearchParams({
      DocumentType: documentType,
      Duration: duration,
      SysModifiedDate: sysDate,
    })}`,
    { headers: { "Authorization": `Bearer ${token}`, "ebp-subscription-key": env.EBP_SUBSCRIPTION_KEY } }
  );
  if (!ebpResp.ok) throw new Error(`EBP error ${ebpResp.status}: ${await ebpResp.text()}`);
  const ebpData   = await ebpResp.json();
  let commandes   = [...(ebpData.results || ebpData)];
  // Infos de pagination éventuelles renvoyées par EBP (tout sauf la liste elle-même), + suivi des pages suivantes
  const metaEbp = Array.isArray(ebpData) ? {} : Object.fromEntries(Object.entries(ebpData).filter(([k]) => k !== "results"));
  const lienSuivant = d => (Array.isArray(d) ? null : (d.next || d.nextLink || d["@odata.nextLink"] || null));
  let pagesEbp = 1;
  let nextUrl = lienSuivant(ebpData);
  while (nextUrl && pagesEbp < 25) {
    const r2 = await fetch(nextUrl, { headers: { "Authorization": `Bearer ${token}`, "ebp-subscription-key": env.EBP_SUBSCRIPTION_KEY } });
    if (!r2.ok) throw new Error(`EBP error (page ${pagesEbp + 1}) ${r2.status}: ${await r2.text()}`);
    const d2 = await r2.json();
    commandes = commandes.concat(d2.results || d2);
    nextUrl = lienSuivant(d2);
    pagesEbp++;
  }

  // Pagination EBP par offset : { paging: { total, returned, offset, limit } }
  let paginationIgnoree = false;
  const total = ebpData.paging?.total;
  if (total && total > commandes.length) {
    const premier = commandes[0]?.DocumentNumber;
    let nomParam = "Offset"; // si EBP l'ignore, on retente en "offset"
    while (commandes.length < total && pagesEbp < 25) {
      const params = new URLSearchParams({ DocumentType: documentType, Duration: duration, SysModifiedDate: sysDate });
      params.set(nomParam, String(commandes.length));
      const rp = await fetch(
        `${EBP_API_BASE}/Folders/${env.EBP_FOLDER_ID}/Documents/SaleDocument/WithLines?${params}`,
        { headers: { "Authorization": `Bearer ${token}`, "ebp-subscription-key": env.EBP_SUBSCRIPTION_KEY } }
      );
      if (!rp.ok) throw new Error(`EBP error (offset ${commandes.length}) ${rp.status}: ${await rp.text()}`);
      const dp = await rp.json();
      const liste = dp.results || dp;
      if (!liste.length) break;
      if (liste[0]?.DocumentNumber === premier) { // paramètre d'offset ignoré : on change de nom, sinon on abandonne
        if (nomParam === "Offset") { nomParam = "offset"; continue; }
        paginationIgnoree = true; break;
      }
      commandes = commandes.concat(liste);
      pagesEbp++;
    }
    // Dédoublonnage par numéro de document
    commandes = [...new Map(commandes.map(c => [c.DocumentNumber, c])).values()];
  }

  // Mode test : n'écrit rien dans Baserow, renvoie juste un aperçu réduit (champs clés
  // uniquement) pour vérifier que le DocumentType testé pointe bien vers les commandes
  // clients (et non devis/factures/BL) sans noyer la réponse sous ~150 champs bruts.
  if (test) {
    return {
      status: "test",
      document_type_teste: documentType,
      total_ebp: commandes.length,
      pages_ebp: pagesEbp,
      meta_ebp: metaEbp,
      apercu: commandes.slice(0, 5).map(c => ({
        DocumentType:      c.DocumentType,
        DocumentNumber:    c.DocumentNumber,
        DocumentDate:      c.DocumentDate,
        CustomerName:      c.CustomerName,
        Reference:         c.Reference,
        ConstructionSiteId: c.ConstructionSiteId,
        AmountVatExcluded: c.AmountVatExcluded,
        NbLignes:          (c.Lines || c.lines || c.DocumentLines || []).length,
      })),
      cles_premier_document: commandes[0] ? Object.keys(commandes[0]) : [],
      champs_statut_detectes: commandes[0]
        ? Object.fromEntries(Object.entries(commandes[0]).filter(([k]) => /state|status|closed|finish|complet|termin|archiv/i.test(k)))
        : {},
    };
  }

  for (const cmd of commandes) {
    const num = cmd.DocumentNumber || "";
    if (!num) continue;

    try {
      let chantierBaserowId = null;
      const constructionSiteId = cmd.ConstructionSiteId || "";
      const reference          = cmd.Reference || "";

      async function chercherChantier(terme) {
        if (!terme) return null;
        const r = await fetch(
          `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_CH}/?user_field_names=true&size=10&filter__Nom du chantier__contains=${encodeURIComponent(terme)}`,
          { headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } }
        );
        if (!r.ok) return null;
        const d = await r.json();
        // Pas de filtre URL sur Statue (champ à sélection unique : rejeté par Baserow).
        // On préfère un chantier non Terminé si plusieurs correspondent.
        const res = d.results || [];
        const actif = res.find(x => (x["Statue"]?.value || x["Statue"] || "") !== "Terminé");
        return (actif || res[0])?.id || null;
      }

      if (constructionSiteId) {
        const code = constructionSiteId.replace(/^CHA0*/, "CH");
        chantierBaserowId = await chercherChantier(code);
      }
      if (!chantierBaserowId) {
        const m = reference.match(/CH\d+/i);
        if (m) chantierBaserowId = await chercherChantier(m[0].toUpperCase());
      }
      if (!chantierBaserowId) {
        const m = reference.match(/DE\s*(\d+)/i);
        if (m) chantierBaserowId = await chercherChantier("DE " + m[1]);
        if (!chantierBaserowId && m) chantierBaserowId = await chercherChantier("DE" + m[1]);
      }

      const date = (cmd.DocumentDate || "").substring(0, 10);

      const payload = {
        "Numero commande":    num,
        "Date commande":      date,
        "Client":             cmd.CustomerName || cmd.ThirdPartyName || "",
        "Chantier":           chantierBaserowId ? [chantierBaserowId] : [],
        "Numero chantier":    constructionSiteId,
        "Designation":        reference,
        "Montant HT":         cmd.AmountVatExcluded ?? 0,
        "Reference complete": reference,
      };

      const searchResp = await fetch(
        `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_CC}/?user_field_names=true&size=1&filter__Numero commande__equal=${encodeURIComponent(num)}`,
        { headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } }
      );
      if (!searchResp.ok) throw new Error(`Baserow search error ${searchResp.status}`);
      const searchData = await searchResp.json();

      let baserowRowId = null;

      if (!searchData.results?.length) {
        const postR = await fetch(
          `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_CC}/?user_field_names=true`,
          { method: "POST", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload) }
        );
        if (!postR.ok) throw new Error(`Baserow POST error: ${await postR.text()}`);
        baserowRowId = (await postR.json()).id;
        nbCrees++;
      } else {
        const existing = searchData.results[0];
        baserowRowId   = existing.id;

        const diff = {};
        for (const champ of CHAMPS_EBP_ENTETE_CLIENT) {
          if (champ === "Chantier") continue;
          const valEBP     = String(payload[champ] ?? "");
          const valBaserow = String(existing[champ] ?? "");
          if (valEBP !== valBaserow) diff[champ] = payload[champ];
        }
        const chantierActuel = (existing["Chantier"] || [])[0]?.id || null;
        if (chantierBaserowId !== chantierActuel) {
          diff["Chantier"] = chantierBaserowId ? [chantierBaserowId] : [];
        }

        if (Object.keys(diff).length > 0) {
          await fetch(
            `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_CC}/${baserowRowId}/?user_field_names=true`,
            { method: "PATCH", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify(diff) }
          );
          nbMaj++;
        } else {
          nbInchanges++;
        }
      }

      const lignesEBP = cmd.Lines || cmd.lines || cmd.DocumentLines || [];
      lignesEBP.sort((a, b) => (a.LineOrder || 0) - (b.LineOrder || 0));
      const lignesEBPFiltrees = lignesEBP.filter(l =>
        (l.DescriptionClear || l.Description || "").trim() || (l.ItemId || "").trim()
      );

      // Regroupement : UNE SEULE ligne Baserow par commande (descriptions concaténées, une par retour à la ligne)
      // ⚠️ Le champ "Description" de la table Lignes doit être de type "Texte long" dans Baserow.
      const fmtNb = n => String(Math.round(Number(n) * 100) / 100);
      const descGroupee = lignesEBPFiltrees.map(l => {
        const d = ((l.DescriptionClear || l.Description || "").trim() || (l.ItemId || "").trim())
          .replace(/\s*[\r\n]+\s*/g, " ");
        const q = Number(l.Quantity || 0);
        return q ? `${d} — ${fmtNb(q)}${l.UnitId ? " " + l.UnitId : ""}` : d;
      }).join("\n");
      const montantTotal = Math.round(
        lignesEBPFiltrees.reduce((t, l) => t + (Number(l.NetAmountVatExcludedWithDiscount) || 0), 0) * 100
      ) / 100;

      const lignesResp = await fetch(
        `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LC}/?user_field_names=true&size=200&filter__Commande__link_row_has=${baserowRowId}`,
        { headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } }
      );
      const lignesBaserow = lignesResp.ok ? (await lignesResp.json()).results || [] : [];
      const [premiere, ...surplus] = lignesBaserow;

      // Nettoyage : anciennes lignes détaillées en surplus
      for (const l of surplus) {
        await fetch(`https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LC}/${l.id}/`,
          { method: "DELETE", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } });
        nbLignesSuppr++;
      }

      if (!descGroupee) {
        if (premiere) {
          await fetch(`https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LC}/${premiere.id}/`,
            { method: "DELETE", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}` } });
          nbLignesSuppr++;
        }
      } else {
        const lignePayload = {
          "Commande":    [baserowRowId],
          "Reference":   "",
          "Description": descGroupee,
          "Unite":       "",
          "Quantite":    null,
          "Montant HT":  montantTotal,
          "Ordre":       0,
        };
        if (!premiere) {
          const liR = await fetch(
            `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LC}/?user_field_names=true`,
            { method: "POST", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify(lignePayload) }
          );
          if (!liR.ok) throw new Error(`Baserow POST ligne error: ${await liR.text()}`);
          nbLignesCrees++;
        } else if (String(premiere["Description"] || "") !== descGroupee || Number(premiere["Montant HT"] || 0) !== montantTotal) {
          const paR = await fetch(
            `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_LC}/${premiere.id}/?user_field_names=true`,
            { method: "PATCH", headers: { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify(lignePayload) }
          );
          if (!paR.ok) throw new Error(`Baserow PATCH ligne error: ${await paR.text()}`);
          nbLignesMaj++;
        }
      }

    } catch(e) {
      erreurs.push({ num, erreur: e.message });
    }
  }

  if (updateDate && !full) await env.EBP_TOKENS.put(LAST_SYNC_KEY_CLIENTS, syncStarted);

  return {
    status:          "ok",
    date:            debut.toISOString(),
    derniere_sync:   lastSync,
    total_ebp:       commandes.length,
    pages_ebp:       pagesEbp,
    pagination_ignoree: paginationIgnoree,
    meta_ebp:        metaEbp,
    commandes_crees: nbCrees,
    commandes_maj:   nbMaj,
    commandes_inch:  nbInchanges,
    lignes_crees:    nbLignesCrees,
    lignes_maj:      nbLignesMaj,
    lignes_suppr:    nbLignesSuppr,
    erreurs,
  };
}

// ============================================================
// SYNC RÉPERTOIRE : tiers EBP (clients + fournisseurs) → Baserow « Répertoire »
// ============================================================
// Tables EBP interrogées via GenericQuery (catégorie affichée dans l'appli, préfixe de la clé « Code EBP »)
const SOURCES_REPERTOIRE = [
  { table: 'Customer', categorie: 'Client',      prefixe: 'C' },
  { table: 'Supplier', categorie: 'Fournisseur', prefixe: 'F' },
];

// Lecture tolérante d'un champ EBP : insensible à la casse et aux « _ » / « . »
function champEbp(rec, candidats) {
  const index = {};
  for (const k of Object.keys(rec)) index[k.toLowerCase().replace(/[_.]/g, '')] = rec[k];
  for (const c of candidats) {
    let v = index[c.toLowerCase().replace(/[_.]/g, '')];
    if (v && typeof v === 'object' && 'value' in v) v = v.value;
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function tiersVersContact(rec, src) {
  const code    = champEbp(rec, ['Id', 'Code']);
  const societe = champEbp(rec, ['Name', 'Caption']);
  const prenom  = champEbp(rec, ['MainInvoicingContact_FirstName', 'MainDeliveryContact_FirstName', 'ContactFirstName', 'FirstName']);
  const nomCt   = champEbp(rec, ['MainInvoicingContact_Name', 'MainDeliveryContact_Name', 'ContactName']);
  const adr = [
    champEbp(rec, ['MainInvoicingAddress_Address1', 'MainDeliveryAddress_Address1', 'Address1']),
    champEbp(rec, ['MainInvoicingAddress_Address2', 'MainDeliveryAddress_Address2', 'Address2']),
    [champEbp(rec, ['MainInvoicingAddress_ZipCode', 'MainDeliveryAddress_ZipCode', 'ZipCode']),
     champEbp(rec, ['MainInvoicingAddress_City', 'MainDeliveryAddress_City', 'City'])].filter(Boolean).join(' '),
  ].filter(Boolean).join('\n');
  return {
    'Code EBP':  `${src.prefixe}:${code}`,
    'Source':    'EBP',
    'Categorie': src.categorie,
    'Societe':   societe,
    'Nom':       [prenom, nomCt].filter(Boolean).join(' ') || societe,
    'Fonction':  champEbp(rec, ['MainInvoicingContact_Function', 'MainDeliveryContact_Function', 'Function']),
    'Telephone': champEbp(rec, ['MainInvoicingContact_Phone', 'MainDeliveryContact_Phone', 'Phone', 'homePhoneNumber']),
    'Mobile':    champEbp(rec, ['MainInvoicingContact_CellPhone', 'MainDeliveryContact_CellPhone', 'CellPhone', 'mobilePhoneNumber']),
    'Email':     champEbp(rec, ['MainInvoicingContact_Email', 'MainDeliveryContact_Email', 'Email']),
    'Adresse':   adr,
  };
}

async function lireTableEbp(env, token, table, depuis) {
  const tous = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const params = new URLSearchParams({ TableName: table, OrderByValue: 'Id', Offset: String(offset), Limit: String(limit) });
    if (depuis) params.set('FromModifiedDate', depuis);
    const r = await fetch(`${EBP_API_BASE}/Folders/${env.EBP_FOLDER_ID}/GenericQuery?${params}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'ebp-subscription-key': env.EBP_SUBSCRIPTION_KEY },
    });
    if (!r.ok) throw new Error(`EBP ${table} ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const lot = d.results || [];
    tous.push(...lot);
    const total = d.paging?.total ?? lot.length;
    offset += lot.length;
    if (!lot.length || offset >= total) break;
  }
  return tous;
}

async function syncRepertoire(env, { full = false, test = false } = {}) {
  const token = await getToken(env);
  const bw = { 'Authorization': `Token ${env.BASEROW_TOKEN}`, 'Content-Type': 'application/json' };
  const debut = new Date().toISOString();
  const depuis = full ? null : await env.EBP_TOKENS.get(LAST_SYNC_KEY_REPERTOIRE);

  // Mode test : aucune écriture, renvoie les clés d'un enregistrement de chaque table EBP
  if (test) {
    const apercu = {};
    for (const src of SOURCES_REPERTOIRE) {
      const p = new URLSearchParams({ TableName: src.table, OrderByValue: 'Id', Offset: '0', Limit: '1' });
      const r = await fetch(`${EBP_API_BASE}/Folders/${env.EBP_FOLDER_ID}/GenericQuery?${p}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'ebp-subscription-key': env.EBP_SUBSCRIPTION_KEY },
      });
      const d = r.ok ? await r.json() : { erreur: `${r.status} ${await r.text()}` };
      const rec = (d.results || [])[0] || null;
      apercu[src.table] = { total: d.paging?.total, cles: rec ? Object.keys(rec) : d, exemple: rec, mappe: rec ? tiersVersContact(rec, src) : null };
    }
    return apercu;
  }

  if (!BASEROW_TABLE_REP || BASEROW_TABLE_REP === "A_COMPLETER") {
    return { erreurs: ["BASEROW_TABLE_REP non renseigné dans le Worker (ID de la table Répertoire)"] };
  }

  // Index des lignes Baserow existantes par « Code EBP »
  const existants = {};
  let url = `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_REP}/?user_field_names=true&size=200`;
  while (url) {
    const r = await fetch(url, { headers: bw });
    if (!r.ok) throw new Error(`Baserow ${r.status}: ${await r.text()}`);
    const d = await r.json();
    for (const row of d.results || []) if (row['Code EBP']) existants[row['Code EBP']] = row;
    url = d.next ? d.next.replace('http://', 'https://') : null;
  }

  const aCreer = [], aMaj = [];
  let lus = 0, inchanges = 0;
  const erreurs = [];
  for (const src of SOURCES_REPERTOIRE) {
    let recs;
    try { recs = await lireTableEbp(env, token, src.table, depuis); }
    catch (e) { erreurs.push(e.message); continue; }
    lus += recs.length;
    for (const rec of recs) {
      // ✅ Confirmé par test du 29/09/2026 : ActiveState 0 = tiers actif. Les tiers en sommeil/bloqués sont ignorés.
      if (rec.ActiveState !== undefined && rec.ActiveState !== null && Number(rec.ActiveState) !== 0) continue;
      const c = tiersVersContact(rec, src);
      if (c['Code EBP'].endsWith(':') || !c['Societe']) continue;
      const ex = existants[c['Code EBP']];
      if (!ex) { aCreer.push(c); continue; }
      // Mise à jour seulement si un champ EBP a changé (Notes n'est jamais touché)
      const diff = Object.keys(c).some(k => (ex[k] || '') !== c[k]);
      if (diff) aMaj.push({ id: ex.id, ...c }); else inchanges++;
    }
  }

  // Écritures groupées (200 lignes max par appel Baserow)
  const lots = (arr) => { const o = []; for (let i = 0; i < arr.length; i += 200) o.push(arr.slice(i, i + 200)); return o; };
  const batchUrl = `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_REP}/batch/?user_field_names=true`;
  for (const lot of lots(aCreer)) {
    const r = await fetch(batchUrl, { method: 'POST', headers: bw, body: JSON.stringify({ items: lot }) });
    if (!r.ok) erreurs.push(`Création ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  for (const lot of lots(aMaj)) {
    const r = await fetch(batchUrl, { method: 'PATCH', headers: bw, body: JSON.stringify({ items: lot }) });
    if (!r.ok) erreurs.push(`Mise à jour ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  if (!erreurs.length) await env.EBP_TOKENS.put(LAST_SYNC_KEY_REPERTOIRE, debut);
  return { mode: full || !depuis ? 'complet' : 'incrémental', tiers_lus: lus, contacts_crees: aCreer.length, contacts_maj: aMaj.length, inchanges, erreurs };
}

// ============================================================
// CATALOGUE ARTICLES : table EBP « Item » → stockage KV du Worker
//   (recherche par /articles/search, /articles/get) + mise à jour des
//   articles en stock dans Baserow « Articles ».
//   ⚠️ Routes protégées par le secret APP_KEY (Cloudflare › Worker ›
//   Settings › Variables › Secret), même valeur que WORKER_APP_KEY dans l'appli.
// ------------------------------------------------------------
// • EBP = catalogue (désignation, code, famille, unité, fournisseur, PA).
//   L'appli gère le stock et les emplacements : Zone, Rayon, Plan_X, Plan_Y,
//   Stock mini ne sont JAMAIS écrits ici.
// • Clé = « Code EBP » (= Item.Id = ItemId des lignes de commande, déjà
//   stocké dans « Reference fournisseur » de la table 1179061).
// • Un article créé par l'appli à la réception (Origine = « Commande ») avec
//   le même code est simplement mis à jour → il passe en Origine « EBP » en
//   gardant stock et emplacement (compté dans « rattaches »).
// • Incrémental (KV last_sync_date_articles) ; ?full=1 relit tout ;
//   ?test=1 = aperçu des champs EBP + répartition par type, sans écriture.
// ============================================================
const BASEROW_TABLE_ART = "1237462"; // ⚠️ ID de la table Baserow « Articles »
const LAST_SYNC_KEY_ARTICLES = "last_sync_date_articles";
const LAST_FULL_KEY_ARTICLES = "last_full_sync_articles";
// Relecture complète automatique tous les N jours : rattache les articles
// créés par l'appli à la réception dont la fiche EBP n'a pas bougé depuis
// (une synchro incrémentale ne les verrait jamais).
const ART_FULL_TOUS_LES_JOURS = 7;
// Types d'articles EBP à ignorer (valeurs de ItemType vues avec ?test=1).
// ✅ Test du 03/10/2026 : 0 = bien, 1 = prestation → les prestations sont exclues.
const ART_TYPES_EXCLUS = ["1"];
// Import complet découpé en tranches : chaque appel lit N pages de 100 articles
// (la table Item contient des images et textes RTF, trop lourds en un seul appel).
const ART_PAGES_PAR_APPEL = 4;
const KV_CATALOGUE_TMP = "catalogue_articles_en_cours";
const KV_ART_FULL_ETAT = "sync_articles_full_etat";
const KV_ART_LIBELLES = "articles_index_libelles";
const CHAMPS_CATALOGUE_ART = ["Designation", "Fournisseur", "Reference fournisseur", "Famille", "Unite", "Prix achat HT", "Actif", "Origine"];

async function lirePageEbp(env, token, table, offset, depuis = null, limit = 100) {
  const params = new URLSearchParams({ TableName: table, OrderByValue: "Id", Offset: String(offset), Limit: String(limit) });
  if (depuis) params.set("FromModifiedDate", depuis);
  const r = await fetch(`${EBP_API_BASE}/Folders/${env.EBP_FOLDER_ID}/GenericQuery?${params}`, {
    headers: { "Authorization": `Bearer ${token}`, "ebp-subscription-key": env.EBP_SUBSCRIPTION_KEY },
  });
  if (!r.ok) throw new Error(`EBP ${table} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const lot = d.results || [];
  return { lot, total: d.paging?.total ?? null };
}

async function lireIndexLibelles(env, token, table) {
  // Id → libellé (familles, fournisseurs), lu page par page sans garder les fiches
  // complètes en mémoire. Silencieux si la table n'est pas autorisée.
  const idx = {};
  try {
    let offset = 0;
    while (true) {
      const { lot, total } = await lirePageEbp(env, token, table, offset);
      for (const r of lot) {
        const id = champEbp(r, ["Id"]);
        if (id) idx[id] = champEbp(r, ["Caption", "Name"]) || id;
      }
      offset += lot.length;
      if (!lot.length || offset >= (total ?? offset)) break;
    }
  } catch (e) { /* table non autorisée : libellés = codes */ }
  return idx;
}

async function indexLibellesArticles(env, token, rafraichir = false) {
  if (!rafraichir) {
    const raw = await env.EBP_TOKENS.get(KV_ART_LIBELLES);
    if (raw) return JSON.parse(raw);
  }
  const idx = { familles: await lireIndexLibelles(env, token, "ItemFamily"), fournisseurs: await lireIndexLibelles(env, token, "Supplier") };
  await env.EBP_TOKENS.put(KV_ART_LIBELLES, JSON.stringify(idx));
  return idx;
}

// Fiche EBP brute → entrée compacte du catalogue (null si exclue)
function recVersCatalogue(rec, libelles, res) {
  const type = champEbp(rec, ["ItemType", "Type"]);
  if (ART_TYPES_EXCLUS.includes(String(type))) { res.ignores++; return null; }
  const a = itemVersArticle(rec, libelles.familles || {}, libelles.fournisseurs || {});
  return a["Code EBP"] ? versCatalogue(a) : null;
}

function itemVersArticle(rec, familles, fournisseurs) {
  const code = champEbp(rec, ["Id"]);
  const famId = champEbp(rec, ["FamilyId", "ItemFamilyId"]);
  const fouId = champEbp(rec, ["SupplierId", "MainSupplierId"]);
  const prix = parseFloat(champEbp(rec, ["PurchasePrice", "CostPrice", "PurchasePriceVatExcluded"]).replace(",", "."));
  const actif = champEbp(rec, ["ActiveState"]);
  return {
    "Code EBP": code,
    "Designation": (champEbp(rec, ["Caption", "DescriptionClear", "Description"]) || code).slice(0, 250),
    "Reference fournisseur": champEbp(rec, ["SupplierItemReference", "MainSupplierItemReference", "SupplierReference"]),
    "Fournisseur": fouId ? (fournisseurs[fouId] || fouId) : "",
    "Famille": famId ? (familles[famId] || famId) : champEbp(rec, ["FamilyCaption"]),
    "Unite": champEbp(rec, ["UnitId", "Unit"]),
    "Prix achat HT": isNaN(prix) ? null : prix,
    "Actif": actif === "" || Number(actif) === 0, // ✅ même convention que les tiers : 0 = actif
    "Origine": "EBP",
  };
}

// ── Catalogue complet stocké dans KV (pas dans Baserow) ──────────────────
// Format compact : { maj, items: [{ c: code, d: désignation, r: réf. fourn.,
// f: fournisseur, fa: famille, u: unité, p: prix achat, a: 1 actif / 0 }] }.
// Baserow « Articles » ne contient que les articles réellement en stock
// (créés par l'appli) : le Worker y met à jour leurs champs catalogue.
const KV_CATALOGUE = "catalogue_articles";
let _catalogueMemo = null, _catalogueMemoT = 0;

function versCatalogue(a) {
  return { c: a["Code EBP"], d: a["Designation"], r: a["Reference fournisseur"], f: a["Fournisseur"],
           fa: a["Famille"], u: a["Unite"], p: a["Prix achat HT"], a: a["Actif"] ? 1 : 0 };
}
function catalogueVersBaserow(x) {
  return { "Code EBP": x.c, "Designation": x.d, "Reference fournisseur": x.r || "", "Fournisseur": x.f || "",
           "Famille": x.fa || "", "Unite": x.u || "", "Prix achat HT": x.p ?? null, "Actif": x.a === 1, "Origine": "EBP" };
}
// Ce que l'appli reçoit : jamais le prix d'achat.
function cataloguePublic(x) {
  return { code: x.c, designation: x.d, ref: x.r || "", fournisseur: x.f || "", famille: x.fa || "", unite: x.u || "" };
}
function normCat(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}
async function lireCatalogue(env, forcer = false) {
  if (!forcer && _catalogueMemo && Date.now() - _catalogueMemoT < 5 * 60000) return _catalogueMemo;
  const raw = await env.EBP_TOKENS.get(KV_CATALOGUE);
  _catalogueMemo = raw ? JSON.parse(raw) : { maj: null, items: [] };
  _catalogueMemoT = Date.now();
  return _catalogueMemo;
}
function rechercherCatalogue(cat, q, limite = 30) {
  const mots = normCat(q).split(" ").filter(Boolean);
  if (!mots.length) return [];
  const qn = normCat(q).replace(/\s/g, "");
  const res = [];
  for (const x of cat.items) {
    if (x.a !== 1) continue;
    const t = normCat(`${x.c} ${x.d} ${x.r} ${x.f} ${x.fa}`);
    if (mots.every(m => t.includes(m))) res.push(x);
  }
  // Code exact d'abord, puis désignation qui commence par la recherche
  res.sort((a, b) => (normCat(b.c) === qn) - (normCat(a.c) === qn)
    || normCat(b.d).startsWith(mots[0]) - normCat(a.d).startsWith(mots[0])
    || String(a.d).localeCompare(String(b.d), "fr"));
  return res.slice(0, limite).map(cataloguePublic);
}
// Tolère les espaces, retours à la ligne et guillemets collés par erreur
// autour de la valeur du secret (copier-coller dans Cloudflare).
function nettoyerCle(v) {
  return String(v || "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}
function cleAppValide(request, url, env) {
  const attendue = nettoyerCle(env.APP_KEY);
  const recue = nettoyerCle(request.headers.get("X-App-Key") || url.searchParams.get("key"));
  return !!attendue && recue === attendue;
}

async function syncArticles(env, { full = false, test = false, restart = false, pages = ART_PAGES_PAR_APPEL } = {}) {
  const token = await getToken(env);
  const debut = new Date().toISOString();

  if (test) {
    const { lot: recs, total } = await lirePageEbp(env, token, "Item", 0);
    const types = {};
    for (const rec of recs) { const t = champEbp(rec, ["ItemType", "Type"]) || "(vide)"; types[t] = (types[t] || 0) + 1; }
    return {
      status: "test", total_ebp: total, cles: recs[0] ? Object.keys(recs[0]) : [],
      types_sur_100_premiers: types, types_exclus: ART_TYPES_EXCLUS,
      mappe: recs.slice(0, 5).map(x => itemVersArticle(x, {}, {})),
    };
  }

  // ── Import complet en tranches (reprend là où l'appel précédent s'est arrêté) ──
  let etat = restart ? null : JSON.parse((await env.EBP_TOKENS.get(KV_ART_FULL_ETAT)) || "null");
  if (!etat && !full) {
    const dernierFull = await env.EBP_TOKENS.get(LAST_FULL_KEY_ARTICLES);
    if (!dernierFull || Date.now() - new Date(dernierFull).getTime() > ART_FULL_TOUS_LES_JOURS * 86400000) full = true;
  }
  if (etat || full) return await importCompletArticles(env, token, etat, pages, debut);

  // ── Incrémental : seules les fiches modifiées depuis la dernière synchro ──
  const depuis = await env.EBP_TOKENS.get(LAST_SYNC_KEY_ARTICLES);
  const res = { status: "ok", mode: "incrémental", lus_ebp: 0, catalogue: 0, maj: 0, rattaches: 0, inchanges: 0, ignores: 0, erreurs: [] };
  const libelles = await indexLibellesArticles(env, token);
  const cat = await lireCatalogue(env, true);
  const parCode = new Map(cat.items.map(x => [x.c, x]));
  const modifies = new Map();
  let offset = 0;
  while (true) {
    const { lot, total } = await lirePageEbp(env, token, "Item", offset, depuis);
    // Trop de fiches modifiées pour un seul appel (ex. mise à jour de tarifs en masse) :
    // on bascule sur l'import complet en tranches, qui reprend au cron suivant.
    if (offset === 0 && total !== null && total > pages * 100) return await importCompletArticles(env, token, null, pages, debut);
    res.lus_ebp += lot.length;
    for (const rec of lot) {
      const x = recVersCatalogue(rec, libelles, res);
      if (x) { parCode.set(x.c, x); modifies.set(x.c, x); }
    }
    offset += lot.length;
    if (!lot.length || offset >= (total ?? offset)) break;
  }
  if (modifies.size) await enregistrerCatalogue(env, { maj: debut, items: [...parCode.values()] });
  res.catalogue = parCode.size;
  await majBaserowArticles(env, modifies, res);
  if (!res.erreurs.length) await env.EBP_TOKENS.put(LAST_SYNC_KEY_ARTICLES, debut); else res.status = "partiel";
  return res;
}

async function importCompletArticles(env, token, etat, pages, debut) {
  // 1er appel : index des familles / fournisseurs, puis catalogue vide
  if (!etat) {
    await indexLibellesArticles(env, token, true);
    etat = { debut, offset: 0, total: null, ignores: 0 };
    await env.EBP_TOKENS.put(KV_CATALOGUE_TMP, "[]");
    await env.EBP_TOKENS.put(KV_ART_FULL_ETAT, JSON.stringify(etat));
    return { status: "en_cours", etape: "index familles / fournisseurs prêt", message: "Rechargez la page pour importer les articles." };
  }

  const libelles = await indexLibellesArticles(env, token);
  const items = JSON.parse((await env.EBP_TOKENS.get(KV_CATALOGUE_TMP)) || "[]");
  const res = { ignores: 0 };
  for (let i = 0; i < pages; i++) {
    const { lot, total } = await lirePageEbp(env, token, "Item", etat.offset);
    if (total !== null) etat.total = total;
    for (const rec of lot) { const x = recVersCatalogue(rec, libelles, res); if (x) items.push(x); }
    etat.offset += lot.length;
    if (!lot.length || etat.offset >= (etat.total ?? etat.offset)) { etat.fini = true; break; }
  }
  etat.ignores += res.ignores;

  if (!etat.fini) {
    await env.EBP_TOKENS.put(KV_CATALOGUE_TMP, JSON.stringify(items));
    await env.EBP_TOKENS.put(KV_ART_FULL_ETAT, JSON.stringify(etat));
    return { status: "en_cours", lus: etat.offset, total: etat.total, retenus: items.length, message: "Rechargez la page pour continuer." };
  }

  // Dernière tranche : le nouveau catalogue remplace l'ancien
  await enregistrerCatalogue(env, { maj: etat.debut, items });
  await env.EBP_TOKENS.delete(KV_CATALOGUE_TMP);
  await env.EBP_TOKENS.delete(KV_ART_FULL_ETAT);
  const fin = { status: "ok", mode: "complet", lus_ebp: etat.offset, catalogue: items.length, ignores: etat.ignores, maj: 0, rattaches: 0, inchanges: 0, erreurs: [] };
  await majBaserowArticles(env, new Map(items.map(x => [x.c, x])), fin);
  if (!fin.erreurs.length) {
    await env.EBP_TOKENS.put(LAST_SYNC_KEY_ARTICLES, etat.debut);
    await env.EBP_TOKENS.put(LAST_FULL_KEY_ARTICLES, etat.debut);
  } else fin.status = "partiel";
  return fin;
}

async function enregistrerCatalogue(env, catalogue) {
  const texte = JSON.stringify(catalogue);
  if (texte.length > 24 * 1024 * 1024) throw new Error("Catalogue trop volumineux pour KV (" + Math.round(texte.length / 1048576) + " Mo)");
  await env.EBP_TOKENS.put(KV_CATALOGUE, texte);
  _catalogueMemo = catalogue; _catalogueMemoT = Date.now();
}

// Met à jour, dans Baserow « Articles », les seuls articles déjà en stock
async function majBaserowArticles(env, modifies, res) {
  if (!modifies.size || !/^\d+$/.test(BASEROW_TABLE_ART)) return;
  const bw = { "Authorization": `Token ${env.BASEROW_TOKEN}`, "Content-Type": "application/json" };
  const aMaj = [];
  let url = `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_ART}/?user_field_names=true&size=200`;
  while (url) {
    const r = await fetch(url, { headers: bw });
    if (!r.ok) throw new Error(`Baserow Articles ${r.status}: ${await r.text()}`);
    const d = await r.json();
    for (const ex of d.results || []) {
      const x = modifies.get(String(ex["Code EBP"] || "").trim());
      if (!x) continue;
      const a = catalogueVersBaserow(x);
      const diff = CHAMPS_CATALOGUE_ART.some(k => {
        if (k === "Prix achat HT") return Math.abs((Number(ex[k]) || 0) - (Number(a[k]) || 0)) > 0.001;
        if (k === "Actif") return !!ex[k] !== !!a[k];
        return String(ex[k] ?? "") !== String(a[k] ?? "");
      });
      if (!diff) { res.inchanges++; continue; }
      if ((ex["Origine"] || "") !== "EBP") res.rattaches++;
      aMaj.push({ id: ex.id, ...a });
    }
    url = d.next ? d.next.replace("http://", "https://") : null;
  }
  let ok = 0;
  for (let i = 0; i < aMaj.length; i += 200) {
    const lot = aMaj.slice(i, i + 200);
    const r = await fetch(`https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE_ART}/batch/?user_field_names=true`,
      { method: "PATCH", headers: bw, body: JSON.stringify({ items: lot }) });
    if (r.ok) ok += lot.length; else res.erreurs.push(`Mise à jour ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  res.maj = ok - res.rattaches;
}

function json(data, extraHeaders = {}, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
