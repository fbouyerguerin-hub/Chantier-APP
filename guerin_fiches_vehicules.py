# -*- coding: utf-8 -*-
r"""
guerin_fiches_vehicules.py
--------------------------
Classeurs Excel du dossier Z:\ORGANISATION\VEHICULES (1 feuille par véhicule)
  -> chaque feuille est copiée en PDF dans Baserow
     (table Véhicules, champ Fichier "Fiche")
  -> l'appli ouvre la fiche en un clic, au bureau comme sur chantier,
     sans aucun lien vers le réseau interne.

- Copie fidèle (mise en forme, logos) : export PDF par Excel, 1 feuille = 1 PDF,
  ajusté à la largeur d'une page. Seule la feuille du véhicule est copiée.
- Seules les feuilles réellement modifiées sont renvoyées dans Baserow.
- Baserow : un seul champ "Immatriculation" = plaque, ou n° de série pour les
  engins/remorques sans plaque.
- Rapprochement feuille <-> véhicule : l'immatriculation OU le n° de série de la
  feuille est comparé au champ "Immatriculation" de Baserow
    1. d'après le nom de l'onglet ("AB-123-CD", "Nacelle 4521873"…)
    2. sinon d'après le contenu (valeur à droite ou sous les libellés
       "Immatriculation" / "N° de série" / "Châssis" / "VIN").
- En-tête de chaque PDF : immatriculation + n° de série lus dans la feuille.
- Nouvel onglet non rapproché -> véhicule créé (plaque si connue, sinon n° de série).
- Feuille supprimée -> fiche retirée de Baserow.
- Tourne en continu, sans fenêtre, démarre avec Windows.

Prix : retirés de chaque PDF (montants, coûts, HT/TTC, cellules en €) ; les
classeurs sources ne sont pas modifiés. Si le masquage échoue, la fiche n'est
pas envoyée.

Prérequis : Windows + Excel installé  (installer_fiches_vehicules.bat s'occupe du reste)
    python guerin_fiches_vehicules.py          (surveillance continue)
    python guerin_fiches_vehicules.py --once   (une seule passe)
    python guerin_fiches_vehicules.py --force  (renvoie toutes les fiches)
    python guerin_fiches_vehicules.py --diagnostic   (teste chaque étape, écrit diagnostic.txt)
    python guerin_fiches_vehicules.py --nettoyer
        (supprime les véhicules créés en double par une version précédente,
         puis renvoie toutes les fiches sur les bons véhicules)
"""

import sys, os, re, json, time, hashlib, logging, tempfile
from datetime import datetime

import requests
import pythoncom
import win32com.client

if sys.stdout:  # absent sous pythonw (exécution sans fenêtre)
    sys.stdout.reconfigure(encoding="utf-8")

# ═══════════════════════ CONFIGURATION ═══════════════════════
# Tous les classeurs Excel de ce dossier sont surveillés (sous-dossiers non parcourus)
SOURCE_DIR = r"Z:\ORGANISATION\VEHICULES"

# Classeurs à ne jamais copier (noms de fichiers), ex : ["Couts vehicules.xlsx"]
CLASSEURS_EXCLUS = []

BASEROW_TOKEN = "4vSm9h4oSi8zZO1yfXhWdflU9IHLdTQh"
TABLE_VEHICULES = 1017158
CHAMP_IMMAT = "Immatriculation"  # plaque OU numéro de série (engins sans plaque)
CHAMP_FICHE = "Fiche"            # champ de type "Fichier" à créer dans Baserow

# Créer dans Baserow le véhicule d'un onglet non rapproché.
# Désactivé : les onglets non reconnus sont listés dans le log, sans créer de doublon.
CREER_VEHICULES = False
INTERVALLE_S = 300               # vérification toutes les 5 min

# Masquage des prix dans les PDF (le classeur source n'est jamais modifié).
# Sont vidés : les valeurs sous / à droite d'un libellé contenant ces mots,
# les cellules au format monétaire (€) et les textes du type "120 €".
MOTS_PRIX = ["PRIX", "MONTANT", "MONTANTS", "COUT", "COÛT", "COUTS", "COÛTS",
             "TARIF", "TARIFS", "HT", "TTC", "TVA", "EUROS", "EUR", "FACTURE"]
# ═════════════════════════════════════════════════════════════

VERSION_FICHE = "sans-prix-1"     # changement -> toutes les fiches sont régénérées
PREFIXE_PDF = "Fiche "           # sert à reconnaître les fiches posées par ce script
DOSSIER_SCRIPT = os.path.dirname(os.path.abspath(__file__))
ETAT_JSON = os.path.join(DOSSIER_SCRIPT, "fiches_vehicules_etat.json")
LOG_FILE = os.path.join(DOSSIER_SCRIPT, "fiches_vehicules.log")
EXTENSIONS = (".xlsx", ".xlsm", ".xls")
API = "https://api.baserow.io/api"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8")]
             + ([logging.StreamHandler(sys.stdout)] if sys.stdout else []),
)
log = logging.getLogger()

AUTH = {"Authorization": f"Token {BASEROW_TOKEN}"}
HEADERS = {**AUTH, "Content-Type": "application/json"}
RE_IMMAT = re.compile(r"^([A-Z]{2}\d{3}[A-Z]{2}|\d{1,4}[A-Z]{1,3}\d{2,3})$")


def norm(txt):
    """AB-123-CD / ab 123 cd / AB123CD -> AB123CD"""
    return re.sub(r"[^A-Z0-9]", "", str(txt or "").upper())


def ressemble_immat(nom):
    return bool(RE_IMMAT.match(norm(nom)))


def ressemble_serie(nom):
    """N° de série : majuscules/chiffres uniquement (tirets, points, / tolérés),
    au moins 5 caractères dont un chiffre. "Sommaire", "Récap 2025" sont exclus."""
    brut = nom.strip()
    return (bool(re.fullmatch(r"[A-Z0-9][A-Z0-9\-./ ]*", brut))
            and len(norm(brut)) >= 5 and bool(re.search(r"\d", brut))
            and not re.fullmatch(r"(19|20)\d\d", norm(brut)))


# Clés internes pour les identifiants lus dans la feuille
ID_PLAQUE, ID_SERIE = "plaque", "serie"


def libelle(veh):
    return (veh.get(CHAMP_IMMAT) or f"#{veh['id']}").strip()


def nom_pdf(veh):
    return PREFIXE_PDF + re.sub(r'[\\/:*?"<>|]', "_", libelle(veh)) + ".pdf"


RE_SIV = re.compile(r"(?<![A-Z0-9])[A-Z]{2}[\s\-]?\d{3}[\s\-]?[A-Z]{2}(?![A-Z0-9])")
RE_FNI = re.compile(r"(?<![A-Z0-9])\d{1,4}[\s\-]?[A-Z]{1,3}[\s\-]?\d{2,3}(?![A-Z0-9])")


def jetons(texte):
    """Identifiants possibles dans un texte : valeur entière, plaques, n° de série.
    "AB-123-CD Master" -> {ABC123CDMASTER, AB123CD} ; "Nacelle 4521873" -> {..., 4521873}"""
    t = str(texte or "").upper()
    res = set()
    if len(norm(t)) >= 4:
        res.add(norm(t))
    for motif in (RE_SIV, RE_FNI):
        for m in motif.finditer(t):
            res.add(norm(m.group()))
    for mot in re.split(r"[^A-Z0-9\-./]+", t):
        n = norm(mot)
        if len(n) >= 5 and re.search(r"\d", n):
            res.add(n)
    return res


def construire_index(vehicules):
    """{jeton: {id véhicule}} à partir du champ Immatriculation (plaque ou n° de série)."""
    index = {}
    for v in vehicules:
        for j in jetons(v.get(CHAMP_IMMAT)):
            index.setdefault(j, set()).add(v["id"])
    return index


def trouver_vehicule(textes, index, par_id):
    """Véhicule dont un identifiant correspond à l'onglet ou au contenu de la feuille.
    Plusieurs candidats (doublons) : identifiant le plus long, puis le plus ancien (id le plus petit)."""
    jet = set()
    for t in textes:
        jet |= jetons(t)
    trouves = {}
    for j in jet:
        for vid in index.get(j, ()):
            trouves[vid] = max(trouves.get(vid, 0), len(j))
    if not trouves:
        return None, False
    meilleur = max(trouves.values())
    ids = sorted(vid for vid, l in trouves.items() if l == meilleur)
    return par_id[ids[0]], len(ids) > 1


# ─────────────────────────── Baserow ───────────────────────────
def charger_vehicules():
    url = f"{API}/database/rows/table/{TABLE_VEHICULES}/?user_field_names=true&size=200"
    lignes = []
    while url:
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json()
        lignes += data.get("results", [])
        url = data.get("next")
        if url:
            url = url.replace("http://", "https://")
    return lignes


def creer_vehicule_complet(donnees):
    r = requests.post(f"{API}/database/rows/table/{TABLE_VEHICULES}/?user_field_names=true",
                      headers=HEADERS, data=json.dumps(donnees), timeout=30)
    r.raise_for_status()
    return r.json()


def envoyer_fiche(row_id, chemin_pdf, visible_name):
    with open(chemin_pdf, "rb") as f:
        r = requests.post(f"{API}/user-files/upload-file/", headers=AUTH,
                          files={"file": (visible_name, f, "application/pdf")}, timeout=120)
    r.raise_for_status()
    nom_serveur = r.json()["name"]
    r = requests.patch(f"{API}/database/rows/table/{TABLE_VEHICULES}/{row_id}/?user_field_names=true",
                       headers=HEADERS,
                       data=json.dumps({CHAMP_FICHE: [{"name": nom_serveur, "visible_name": visible_name}]}),
                       timeout=30)
    r.raise_for_status()


def retirer_fiche(row_id):
    r = requests.patch(f"{API}/database/rows/table/{TABLE_VEHICULES}/{row_id}/?user_field_names=true",
                       headers=HEADERS, data=json.dumps({CHAMP_FICHE: []}), timeout=30)
    r.raise_for_status()


def a_notre_fiche(veh):
    return any((f.get("visible_name") or "").startswith(PREFIXE_PDF) for f in (veh.get(CHAMP_FICHE) or []))


# ─────────────────────────── Classeurs ───────────────────────────
def lister_classeurs():
    exclus = {c.lower() for c in CLASSEURS_EXCLUS}
    return sorted(
        os.path.join(SOURCE_DIR, f) for f in os.listdir(SOURCE_DIR)
        if f.lower().endswith(EXTENSIONS) and not f.startswith("~$")
        and f.lower() not in exclus and os.path.isfile(os.path.join(SOURCE_DIR, f))
    )


def signature_sources():
    """{classeur: date de modif} : change dès qu'un classeur est modifié, ajouté ou retiré."""
    return {c: os.path.getmtime(c) for c in lister_classeurs()}


def _txt(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def lire_identifiants(ws):
    """Cherche les libellés "Immatriculation" et "N° de série" dans la feuille
    et prend la valeur de la cellule à droite (ou dessous)."""
    trouves = {}
    try:
        grille = ws.Range("A1:AD80").Value2
    except Exception:
        return trouves
    libelles = {
        ID_PLAQUE: re.compile(r"^(IMMAT|IMMATRICULATION|N°IMMAT|PLAQUE)"),
        ID_SERIE: re.compile(r"^(N°|NO|NUM|NUMERO|NUMÉRO)?\s*(DE)?\s*(SERIE|SÉRIE|CHASSIS|CHÂSSIS)|^VIN$"),
    }
    for i, ligne in enumerate(grille):
        for j, cell in enumerate(ligne):
            t = _txt(cell).upper().rstrip(" :")
            if not t or len(t) > 40:
                continue
            for champ, motif in libelles.items():
                if champ in trouves or not motif.search(t):
                    continue
                voisins = [ligne[k] for k in range(j + 1, min(j + 4, len(ligne)))]
                voisins += [grille[k][j] for k in range(i + 1, min(i + 3, len(grille)))]
                for v in voisins:
                    val = _txt(v)
                    if val and len(norm(val)) >= 4 and not motif.search(val.upper()):
                        trouves[champ] = val
                        break
    return trouves


def entete(veh, ids):
    """Plaque et n° de série lus dans la feuille, complétés par Baserow."""
    plaque = ids.get(ID_PLAQUE, "")
    serie = ids.get(ID_SERIE, "")
    ref = (veh.get(CHAMP_IMMAT) or "").strip()
    if ref and norm(ref) not in (norm(plaque), norm(serie)):
        if not plaque and ressemble_immat(ref):
            plaque = ref
        elif not serie:
            serie = ref
    return f"Immatriculation : {plaque or '—'}     N° de série : {serie or '—'}"


def empreinte_feuille(ws, veh, ids):
    """Contenu + identifiants : ne renvoie que les fiches réellement modifiées."""
    try:
        contenu = repr(ws.UsedRange.Formula) + repr(ws.UsedRange.Address)
    except Exception:
        contenu = str(time.time())
    return hashlib.md5((VERSION_FICHE + ws.Name + entete(veh, ids) + contenu).encode("utf-8", "ignore")).hexdigest()


MOTIF_PRIX = re.compile(r"(^|[^A-Z0-9ÀÂÉÈÊÎÔÛ])(" + "|".join(re.escape(m) for m in MOTS_PRIX)
                        + r")(?=$|[^A-Z0-9ÀÂÉÈÊÎÔÛ])")


def masquer_prix(ws):
    """Vide les prix de la feuille, en mémoire uniquement (classeur ouvert en
    lecture seule et refermé sans enregistrer). Lève une exception en cas
    d'échec : la fiche n'est alors PAS envoyée, pour ne jamais publier de prix."""
    ur = ws.UsedRange
    r0, c0 = ur.Row, ur.Column
    g = ur.Value2
    if not isinstance(g, tuple):
        g = ((g,),)
    nb_l, nb_c = len(g), len(g[0])

    def est_num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    def est_txt_euro(v):
        return isinstance(v, str) and "€" in v and bool(re.search(r"\d", v))

    def est_prix_possible(v):
        return est_num(v) or est_txt_euro(v)

    a_vider = set()
    for i in range(nb_l):
        for j in range(nb_c):
            v = g[i][j]
            if est_txt_euro(v):
                a_vider.add((i, j))
            elif est_num(v):
                try:
                    fmt = str(ws.Cells(r0 + i, c0 + j).NumberFormat or "")
                except Exception:
                    fmt = ""
                if "€" in fmt or "[$EUR" in fmt.upper():
                    a_vider.add((i, j))
            if not isinstance(v, str):
                continue
            t = v.strip().upper()
            if not t or len(t) > 40 or not (MOTIF_PRIX.search(t) or t.rstrip(" :()").endswith("€")):
                continue
            # Libellé de colonne : valeurs en dessous, jusqu'au prochain titre texte
            for k in range(i + 1, nb_l):
                w = g[k][j]
                if est_prix_possible(w):
                    a_vider.add((k, j))
                elif isinstance(w, str) and w.strip():
                    break
            # Libellé de ligne : valeurs à droite (3 cellules max)
            for k in range(j + 1, min(j + 4, nb_c)):
                w = g[i][k]
                if est_prix_possible(w):
                    a_vider.add((i, k))
                elif isinstance(w, str) and w.strip():
                    break

    if not a_vider:
        return 0
    if ws.ProtectContents:
        ws.Unprotect()  # sans mot de passe ; échoue sinon -> fiche non envoyée
    for i, j in a_vider:
        ws.Cells(r0 + i, c0 + j).MergeArea.ClearContents()
    return len(a_vider)


def exporter_pdf(ws, veh, ids, chemin_pdf):
    nb = masquer_prix(ws)
    if nb:
        log.info(f"     💶 {nb} prix masqué(s) sur {ws.Name}")
    # Réglages en mémoire uniquement : le classeur source n'est jamais enregistré
    try:
        ps = ws.PageSetup
        ps.Zoom = False
        ps.FitToPagesWide = 1            # tout sur la largeur d'une page
        ps.FitToPagesTall = False
        ps.CenterHeader = "&B&12" + entete(veh, ids).replace("&", "&&")
        ps.RightFooter = "Fiche en lecture seule – page &P/&N"
    except Exception:
        pass
    ws.ExportAsFixedFormat(0, chemin_pdf, 0, True, False, OpenAfterPublish=False)


# ─────────────────────────── Passe complète ───────────────────────────
def traiter(forcer=False):
    log.info("▶ Mise à jour des fiches véhicules")
    etat = lire_etat()
    empreintes = {} if forcer else etat.get("empreintes", {})

    vehicules = charger_vehicules()
    index = construire_index(vehicules)
    par_id = {v["id"]: v for v in vehicules}
    vus, ignorees, envoyees = set(), [], 0
    tmp = tempfile.mkdtemp(prefix="fiches_veh_")

    pythoncom.CoInitialize()
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    excel.AskToUpdateLinks = False
    excel.ScreenUpdating = False
    try:
        for classeur in lister_classeurs():
            log.info(f"  📘 {os.path.basename(classeur)}")
            wb = None
            try:
                wb = excel.Workbooks.Open(classeur, UpdateLinks=0, ReadOnly=True)
                for ws in wb.Worksheets:
                    nom = ws.Name
                    if ws.Visible != -1:
                        continue
                    ids = lire_identifiants(ws)
                    veh, ambigu = trouver_vehicule([nom] + list(ids.values()), index, par_id)
                    if ambigu:
                        log.warning(f"  ⚠️  {nom} : plusieurs véhicules Baserow correspondent (doublons ?) "
                                    f"-> fiche posée sur le plus ancien ({libelle(veh)}, id {veh['id']})")
                    if not veh and CREER_VEHICULES:
                        ident = ids.get(ID_PLAQUE) or ids.get(ID_SERIE) or (
                            nom.strip() if (ressemble_immat(nom) or ressemble_serie(nom)) else "")
                        if ident:
                            try:
                                veh = creer_vehicule_complet({CHAMP_IMMAT: ident})
                                par_id[veh["id"]] = veh
                                for j in jetons(ident):
                                    index.setdefault(j, set()).add(veh["id"])
                                log.info(f"  ➕ Nouveau véhicule créé dans Baserow : {ident}")
                            except Exception as e:
                                log.error(f"  ❌ Création véhicule {nom} : {e}")
                    if not veh:
                        ignorees.append(f"{nom} ({os.path.basename(classeur)})")
                        continue
                    cle = str(veh["id"])
                    if cle in vus:
                        log.warning(f"  ⚠️  {nom} présent dans plusieurs classeurs : 1re feuille conservée")
                        continue
                    vus.add(cle)

                    emp = empreinte_feuille(ws, veh, ids)
                    if empreintes.get(cle) == emp and a_notre_fiche(veh):
                        continue  # inchangée
                    try:
                        visible = nom_pdf(veh)
                        chemin = os.path.join(tmp, visible)
                        exporter_pdf(ws, veh, ids, chemin)
                        envoyer_fiche(veh["id"], chemin, visible)
                        empreintes[cle] = emp
                        envoyees += 1
                        log.info(f"  ✅ {nom} -> {libelle(veh)}")
                    except Exception as e:
                        log.error(f"  ❌ {nom} : {e}")
            except Exception as e:
                log.error(f"  ❌ Ouverture {classeur} : {e}")
            finally:
                if wb is not None:
                    wb.Close(SaveChanges=False)
    finally:
        excel.Quit()
        pythoncom.CoUninitialize()
        for f in os.listdir(tmp):
            try:
                os.remove(os.path.join(tmp, f))
            except Exception:
                pass
        try:
            os.rmdir(tmp)
        except Exception:
            pass

    # Feuilles supprimées : retirer la fiche de Baserow
    for v in par_id.values():
        cle = str(v["id"])
        if cle not in vus and a_notre_fiche(v):
            try:
                retirer_fiche(v["id"])
                empreintes.pop(cle, None)
                log.info(f"  🧹 Fiche retirée (feuille supprimée) : {libelle(v)}")
            except Exception as e:
                log.error(f"  ❌ Retrait {libelle(v)} : {e}")

    if ignorees:
        log.warning("  ⚠️  Onglets sans véhicule correspondant dans Baserow : " + ", ".join(ignorees))
    log.info(f"■ Terminé : {envoyees} fiche(s) mise(s) à jour, {len(vus) - envoyees} inchangée(s)")
    return empreintes


def lire_etat():
    try:
        with open(ETAT_JSON, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def ecrire_etat(etat):
    with open(ETAT_JSON, "w", encoding="utf-8") as f:
        json.dump(etat, f)


def passe(forcer=False):
    sig = signature_sources()
    empreintes = traiter(forcer)
    ecrire_etat({"sources": sig, "empreintes": empreintes,
                 "derniere_passe": datetime.now().isoformat(timespec="seconds")})


# ─────────────────────────── Nettoyage des doublons ───────────────────────────
def nettoyer_doublons():
    """Supprime les véhicules créés automatiquement (trace dans le log) qui font doublon
    avec un véhicule plus ancien. Le véhicule d'origine (id le plus petit) est conservé."""
    crees = set()
    motif = re.compile(r"Nouveau véhicule créé dans Baserow(?: \([^)]*\))? : (.+?)\s*$")
    try:
        with open(LOG_FILE, encoding="utf-8") as f:
            for ligne in f:
                m = motif.search(ligne)
                if m:
                    crees.add(norm(m.group(1)))
    except FileNotFoundError:
        pass

    vehicules = charger_vehicules()
    index = construire_index(vehicules)
    a_supprimer = []
    for v in vehicules:
        if norm(v.get(CHAMP_IMMAT)) not in crees:
            continue
        jumeaux = set()
        for j in jetons(v.get(CHAMP_IMMAT)):
            jumeaux |= {vid for vid in index.get(j, ()) if vid < v["id"]}
        if jumeaux:
            orig = min(jumeaux)
            a_supprimer.append((v, next(x for x in vehicules if x["id"] == orig)))

    print(f"\n{len(crees)} véhicule(s) créé(s) automatiquement trouvé(s) dans le log.")
    if not a_supprimer:
        print("Aucun doublon à supprimer.")
    else:
        print(f"{len(a_supprimer)} doublon(s) :")
        for v, o in a_supprimer:
            print(f"   - {libelle(v):<25} (id {v['id']})  doublon de  {libelle(o)} (id {o['id']}, conservé)")
        if input("\nSupprimer ces doublons ? (o/n) ").strip().lower().startswith("o"):
            for v, _ in a_supprimer:
                r = requests.delete(f"{API}/database/rows/table/{TABLE_VEHICULES}/{v['id']}/", headers=AUTH, timeout=30)
                if r.ok:
                    log.info(f"  🗑  Doublon supprimé : {libelle(v)} (id {v['id']})")
                else:
                    log.error(f"  ❌ Suppression {libelle(v)} : {r.status_code} {r.text[:200]}")
            print("Doublons supprimés (récupérables dans la corbeille Baserow).")
        else:
            print("Aucune suppression.")
    print("\nRenvoi de toutes les fiches sur les bons véhicules…")
    passe(forcer=True)
    print("Terminé. Détail dans fiches_vehicules.log")


# ─────────────────────────── Diagnostic ───────────────────────────
def diagnostic():
    sortie = os.path.join(DOSSIER_SCRIPT, "diagnostic.txt")
    lignes = []

    def out(msg=""):
        print(msg)
        lignes.append(msg)

    out(f"DIAGNOSTIC FICHES VÉHICULES – {datetime.now():%d/%m/%Y %H:%M}")
    out(f"Python : {sys.executable}")

    # 1. Processus en arrière-plan
    try:
        import subprocess
        tl = subprocess.run(["tasklist", "/FI", "IMAGENAME eq pythonw.exe"], capture_output=True, text=True).stdout
        out("1. Surveillance en arrière-plan : " + ("✅ pythonw.exe actif" if "pythonw.exe" in tl else "❌ aucun pythonw.exe en cours"))
    except Exception as e:
        out(f"1. Surveillance : ? ({e})")

    # 2. Classeurs
    try:
        cls = lister_classeurs()
        out(f"2. Dossier {SOURCE_DIR} : ✅ {len(cls)} classeur(s)")
        for c in cls:
            out(f"      - {os.path.basename(c)}")
        if not cls:
            out("   ❌ Aucun classeur trouvé")
    except Exception as e:
        out(f"2. Dossier {SOURCE_DIR} : ❌ {e}")
        cls = []

    # 3. Baserow
    try:
        vehicules = charger_vehicules()
        out(f"3. Baserow : ✅ {len(vehicules)} véhicule(s) lus")
        if vehicules:
            champs = list(vehicules[0].keys())
            out(f"   Champs de la table : {', '.join(champs)}")
            if CHAMP_FICHE not in champs:
                out(f"   ❌ Champ « {CHAMP_FICHE} » INTROUVABLE (à créer, type Fichier, nom exact)")
            elif not isinstance(vehicules[0].get(CHAMP_FICHE), list):
                out(f"   ❌ Champ « {CHAMP_FICHE} » n'est pas de type Fichier")
            else:
                out(f"   ✅ Champ « {CHAMP_FICHE} » présent (type Fichier)")
            if CHAMP_IMMAT not in champs:
                out(f"   ❌ Champ « {CHAMP_IMMAT} » introuvable")
    except Exception as e:
        out(f"3. Baserow : ❌ {e}")
        vehicules = []

    # 4. Rapprochement + test export PDF / envoi sur le 1er véhicule reconnu
    index = construire_index(vehicules)
    par_id = {v["id"]: v for v in vehicules}
    test_fait = False
    try:
        pythoncom.CoInitialize()
        excel = win32com.client.DispatchEx("Excel.Application")
        excel.Visible = False
        excel.DisplayAlerts = False
        out("4. Excel : ✅ lancé")
    except Exception as e:
        out(f"4. Excel : ❌ {e}")
        excel = None
    if excel:
        tmp = tempfile.mkdtemp(prefix="diag_veh_")
        try:
            for c in cls:
                out(f"\n   📘 {os.path.basename(c)}")
                wb = None
                try:
                    wb = excel.Workbooks.Open(c, UpdateLinks=0, ReadOnly=True)
                    for ws in wb.Worksheets:
                        if ws.Visible != -1:
                            out(f"      {ws.Name:<30} (masquée, ignorée)")
                            continue
                        ids = lire_identifiants(ws)
                        veh, ambigu = trouver_vehicule([ws.Name] + list(ids.values()), index, par_id)
                        lus = ", ".join(f"{k}={v}" for k, v in ids.items()) or "aucun identifiant lu"
                        if veh:
                            out(f"      {ws.Name:<30} ✅ -> {libelle(veh)} (id {veh['id']}){' ⚠️ doublon' if ambigu else ''}  [{lus}]")
                        else:
                            out(f"      {ws.Name:<30} ❌ non rapprochée  [{lus}]")
                        if veh and not test_fait:
                            test_fait = True
                            chemin = os.path.join(tmp, nom_pdf(veh))
                            try:
                                exporter_pdf(ws, veh, ids, chemin)
                                out(f"         Test export PDF : ✅ {os.path.getsize(chemin) // 1024} Ko")
                                try:
                                    envoyer_fiche(veh["id"], chemin, nom_pdf(veh))
                                    out(f"         Test envoi Baserow : ✅ fiche posée sur {libelle(veh)}")
                                except requests.HTTPError as e:
                                    out(f"         Test envoi Baserow : ❌ {e.response.status_code} {e.response.text[:300]}")
                                except Exception as e:
                                    out(f"         Test envoi Baserow : ❌ {e}")
                            except Exception as e:
                                out(f"         Test export PDF : ❌ {e}")
                except Exception as e:
                    out(f"      ❌ Ouverture : {e}")
                finally:
                    if wb is not None:
                        wb.Close(SaveChanges=False)
        finally:
            excel.Quit()
            pythoncom.CoUninitialize()

    # 5. Fin du journal
    out("\n5. Dernières lignes de fiches_vehicules.log :")
    try:
        with open(LOG_FILE, encoding="utf-8") as f:
            for l in f.readlines()[-25:]:
                out("   " + l.rstrip())
    except FileNotFoundError:
        out("   ❌ Aucun journal : le script n'a jamais tourné")

    with open(sortie, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes))
    print(f"\n>>> Résultat enregistré dans {sortie}")


def main():
    if "--diagnostic" in sys.argv:
        diagnostic()
        return
    if "--nettoyer" in sys.argv:
        nettoyer_doublons()
        return
    if "--once" in sys.argv or "--force" in sys.argv:
        passe(forcer="--force" in sys.argv)
        return

    log.info(f"Surveillance des classeurs de {SOURCE_DIR} (toutes les {INTERVALLE_S // 60} min)")
    while True:
        try:
            sig = signature_sources()
            if lire_etat().get("sources") != sig:
                time.sleep(20)  # laisser l'enregistrement se terminer
                if signature_sources() == sig:
                    passe()
                    continue
        except FileNotFoundError:
            log.error(f"Dossier introuvable : {SOURCE_DIR} (lecteur Z: connecté ?)")
        except Exception as e:
            log.error(f"Erreur : {e}")
        time.sleep(INTERVALLE_S)


if __name__ == "__main__":
    main()
