"""
guerin_commandes_scan.py
=========================
Scanne un repertoire local a la recherche de PDF de commande Guerin Batiments
(modele EBP fixe : "Commande CFxxxxxxxx"), en extrait les informations, les
rattache au chantier concerne (via TABLE_CHANTIERS_ADMIN) et pousse le tout
dans deux tables Baserow :

  - Commandes Fournisseurs         (TABLE_COMMANDES)       : 1 ligne = 1 commande (entete)
  - Commandes Fournisseurs Lignes  (TABLE_COMMANDE_LIGNES) : 1 ligne = 1 article de la commande

Concu pour tourner en tache planifiee Windows (meme principe que
guerin_backup_baserow.py), ou etre lance manuellement.

Prerequis :
    pip install pdfplumber requests fpdf2

A FAIRE AVANT LA PREMIERE EXECUTION (cote Baserow) :
  1. Creer une table "Commandes" avec les champs :
       Numero commande (texte)      -> ex: CF00009124
       Date commande (date)
       Fournisseur (texte)
       Chantier (lien -> table Chantiers)
       Numero chantier (texte)      -> ex: CH1170 (garde en texte brut en plus du lien,
                                       pratique pour filtrer/afficher sans deplier le lien)
       Designation (texte)          -> reste de la ligne Reference (nom chantier +
                                       libelle libre, non fiable pour le matching,
                                       informatif uniquement)
       PDF (fichier)                -> le PDF original de la commande (avec prix),
                                       televerse automatiquement - reserve
                                       Gestionnaire/Administrateur cote appli
       PDF sans prix (fichier)      -> genere automatiquement par le script a partir
                                       des donnees extraites (memes articles, sans
                                       montants) - accessible a tous cote appli
       Montant total HT (nombre)
       Montant total TVA (nombre)
       Net a payer (nombre)
       Fichier source (texte)
       Statut (choix : En attente AR / En attente réception / Réceptionné en atelier /
               Réceptionné sur chantier)

  2. Creer une table "Commande Lignes" avec les champs :
       Commande (lien -> table Commandes)
       Categorie (texte)            -> ex: "Pliage Acier GALVA ep 2.00 mm"
       Reference fournisseur (texte)
       Description (texte)
       Unite (texte)
       Quantite (nombre)
       Deboursé HT (nombre)
       Montant HT (nombre)
       TVA (nombre)

  3. Renseigner les ID de tables et le champ de rapprochement chantier ci-dessous.
"""

import json
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import pdfplumber
import requests
from fpdf import FPDF

# --------------------------------------------------------------------------
# CONFIGURATION - a completer
# --------------------------------------------------------------------------

WATCH_DIR = Path(r"C:\GuerinApps\Commandes\Export Commande")   # repertoire a surveiller
TRAITE_DIR = WATCH_DIR / "Traite"                        # PDF traites avec succes
ERREUR_DIR = WATCH_DIR / "Erreur"                        # PDF en echec d'extraction
PROCESSED_LOG = WATCH_DIR / ".commandes_traitees.json"    # historique anti-doublon

BASEROW_TOKEN = "4vSm9h4oSi8zZO1yfXhWdflU9IHLdTQh"
BASEROW_URL = "https://api.baserow.io/api/database/rows/table"
BASEROW_UPLOAD_URL = "https://api.baserow.io/api/user-files/upload-file/"

TABLE_CHANTIERS_ADMIN = 1014441        # existant
TABLE_COMMANDES = 1179060              # Commandes Fournisseurs
TABLE_COMMANDE_LIGNES = 1179061        # Commandes Fournisseurs Lignes

INTERVALLE_SECONDES = 300              # frequence de verification du dossier (5 min)

# Nom exact du champ dans TABLE_CHANTIERS_ADMIN. Il contient
# "CH1170 Nom du chantier..." -> on ne compare que les 6 premiers
# caracteres (voir resoudre_chantier_id).
CHAMP_NUMERO_CHANTIER = "Nom du chantier"

# Chantier de repli utilise quand ni le code CHxxxx ni le numero de devis
# ne permettent d'identifier un chantier (ex: commande de stock general,
# non affectee a un chantier precis).
NOM_CHANTIER_STOCK_ATELIER = "STOCK ATELIER"

HEADERS = {
    "Authorization": f"Token {BASEROW_TOKEN}",
    "Content-Type": "application/json",
}

# --------------------------------------------------------------------------
# EXTRACTION PDF
# --------------------------------------------------------------------------

def extraire_commande(pdf_path: Path) -> dict:
    """Extrait les informations d'un PDF de commande Guerin (modele EBP fixe).
    Concatene toutes les pages (une commande peut comporter plusieurs pages
    d'articles) ; les en-tetes/pieds de page repetes sur chaque page sont
    filtres plus loin lors de la detection des categories d'articles."""
    with pdfplumber.open(pdf_path) as pdf:
        textes_pages = [p.extract_text() or "" for p in pdf.pages]
    texte = "\n".join(textes_pages)

    if not texte.strip():
        raise ValueError("Aucun texte extrait (PDF scanne/image ?)")

    donnees = {"fichier_source": pdf_path.name}

    # Numero de commande + date
    m = re.search(r"\b(CF\d+)\b", texte)
    donnees["numero_commande"] = m.group(1) if m else None

    m = re.search(r"Le\s+(\d{2}/\d{2}/\d{4})", texte)
    donnees["date_commande"] = m.group(1) if m else None

    # Fournisseur (1ere ligne suivant l'en-tete "... Fournisseur")
    m = re.search(r"Fournisseur\s*\n(.+)", texte)
    donnees["fournisseur"] = m.group(1).strip() if m else None

    # Reference : "FB / CH1170 / ST FULGENT PROFIL SUPPORT BARDAGE"
    #   FB       -> initiales du charge d'affaires (non retenu ici)
    #   CH1170   -> numero de chantier, stable, sert de cle de rapprochement
    #   reste    -> nom de chantier + designation libre, non separables de
    #               facon fiable (le nom de chantier n'est pas toujours
    #               identique cote saisie) -> conserve tel quel, informatif
    #               uniquement, jamais utilise pour le rapprochement Baserow.
    m_ref_complete = re.search(r"R[ée]f[ée]rence\s*:\s*(.+)", texte)
    donnees["reference_complete"] = m_ref_complete.group(1).strip() if m_ref_complete else None

    m = re.search(
        r"R[ée]f[ée]rence\s*:\s*\S+\s*/\s*(CH\d+)\s*/\s*(.+)",
        texte,
    )
    if m:
        donnees["numero_chantier"] = m.group(1).strip()
        donnees["designation"] = m.group(2).strip()
    else:
        donnees["numero_chantier"] = None
        donnees["designation"] = None

    # Numero de devis (ex: "DE6498", "DE6482-01" ou "DE 6482-01" avec un
    # espace apres "DE"), repere dans le reste de la ligne Reference (souvent
    # colle au nom du chantier, ex: "SAINT FULGENT DE6282 - CHEVILLES" ou
    # "SAINT FULGENT DE 6482-01"). Sert de repli pour le rapprochement
    # chantier quand le code CHxxxx ne matche pas (le numero de devis
    # apparait generalement aussi dans le nom du chantier cote Baserow).
    # Normalise sans espace ("DE 6482" -> "DE6482") pour matcher le format
    # attendu cote Baserow.
    m_devis = re.search(r"\bDE\s?(\d{3,}(?:-\d+)?)\b", texte)
    donnees["numero_devis"] = ("DE" + m_devis.group(1)) if m_devis else None

    # Totaux
    nombre_montant = r"\d{1,3}(?: \d{3})*,\d{2}"

    def _montant(label):
        mm = re.search(rf"{label}\s+({nombre_montant})", texte)
        if not mm:
            return None
        return float(mm.group(1).replace(" ", "").replace(",", "."))

    donnees["total_ht"] = _montant("Total HT")
    donnees["total_tva"] = _montant("Total TVA")
    m = re.search(rf"Net\s+[àa]\s+payer\s+({nombre_montant})", texte)
    donnees["net_a_payer"] = (
        float(m.group(1).replace(" ", "").replace(",", ".")) if m else None
    )

    # Lignes articles : chaque ligne se termine par 4 valeurs chiffrees
    # (Qte, Debourse HT, Montant HT, TVA - toujours au format "x,xx"), precedees
    # de l'Unite (texte libre : "ML", "U", mais parfois un nombre comme "100").
    # Le debut de ligne est "[Ref.fourn optionnel] Description" - la Ref.fourn.
    # peut etre absente (colonne vide) : elle n'est retenue que si le premier
    # mot est purement numerique (code fournisseur), sinon tout est description.
    lignes = texte.splitlines()
    nombre = r"\d{1,3}(?: \d{3})*,\d{2}"  # ex: "88,00" ou "1 234,56" (sans faux-positif sur un token voisin)
    motif_ligne = re.compile(
        rf"^(.+?)\s+(\S+)\s+({nombre})\s+({nombre})\s+({nombre})\s+({nombre})$"
    )
    # En-tetes/pieds de page qui se repetent sur chaque page (logo, adresses,
    # mentions legales...) : a ignorer lors de la detection des categories
    # d'articles, sinon ils ecraseraient la vraie categorie en cours sur les
    # commandes de plusieurs pages.
    motif_boilerplate = re.compile(
        r"^Commande$"
        r"|^CF\d+$"
        r"|^Le \d{2}/\d{2}/\d{4}$"
        r"|Adresse de livraison"
        r"|^Fournisseur$"
        r"|R[ée]f[ée]rence\s*:"
        r"|GU[EÉ]RIN"
        r"|AGRICOLES|AVICOLES|INDUSTRIELS"
        r"|www\."
        r"|SAS AU CAPITAL"
        r"|N° TVA INTRACOMMUNAUTAIRE"
        r"|Assur\. d[ée]c[ée]nale"
        r"|AXA TESSON"
        r"|pl\. G[ée]n[ée]ral Leclerc"
        r"|valable en France"
        r"|Document cr[ée][ée] par"
        r"|^\d{2}[ .]\d{2}[ .]\d{2}[ .]\d{2}[ .]\d{2}$"
        r"|^2 ZA LE PONT GIROUARD"
        r"|85\s?250.*(ST ANDRE|SAINT-ANDR)"
        r"|TEL\.|FAX"
        r"|contact@guerin-batiments\.fr",
        re.IGNORECASE,
    )
    articles = []
    categorie_courante = None
    dernier_type = "demarrage"  # 'demarrage' | 'item' | 'categorie'
    dans_tableau = False  # ne commence l'analyse qu'apres l'en-tete du
                           # tableau (evite que l'adresse du fournisseur ou
                           # sa raison sociale soit prise pour une categorie)
    for ligne in lignes:
        brut = ligne.strip()

        if "Réf.fourn" in brut:
            dans_tableau = True
            continue

        if not dans_tableau:
            continue

        mm = motif_ligne.match(brut)
        if mm:
            avant, unite, qte, debourse, montant_ht, tva = mm.groups()
            avant = avant.strip()
            parties = avant.split(None, 1)
            if parties and parties[0].isdigit() and len(parties[0]) >= 4:
                reference_fournisseur = parties[0]
                description = parties[1] if len(parties) > 1 else ""
            else:
                reference_fournisseur = ""
                description = avant
            articles.append(
                {
                    "categorie": categorie_courante,
                    "reference_fournisseur": reference_fournisseur,
                    "description": description,
                    "unite": unite,
                    "quantite": float(qte.replace(" ", "").replace(",", ".")),
                    "debourse_ht": float(debourse.replace(" ", "").replace(",", ".")),
                    "montant_ht": float(montant_ht.replace(" ", "").replace(",", ".")),
                    "tva": float(tva.replace(" ", "").replace(",", ".")),
                }
            )
            dernier_type = "item"
            continue

        if not brut or re.match(r"^(Taux|Total|Net)", brut) or motif_boilerplate.search(brut):
            # Ligne vide, totaux ou en-tete/pied de page repete : ignoree,
            # sans influencer l'etat en cours.
            continue

        if dernier_type == "item" and (
            brut.isupper()
            or re.match(r"^[\d\s.,]+$", brut)
            or brut[:1].islower()  # reprise en minuscule d'un mot coupe (ex:
                                    # "mm RAL 1015" a la suite de "...dev 85")
        ):
            # Reste d'une description coupee sur plusieurs lignes juste apres
            # un article (ex: "STOCK", "COMMANDE URGENTE" en majuscules, ou
            # un nombre isole comme "100" apres "boite de") : rattache a la
            # description du dernier article lu plutot que d'etre perdu.
            # Le type reste "item" : d'autres lignes de ce type peuvent
            # continuer a s'accumuler sur ce meme article.
            if articles:
                articles[-1]["description"] = (articles[-1]["description"] + " " + brut).strip()
            continue

        # Sinon : ligne d'en-tete de categorie (ex: "Pliage Acier GALVA ép
        # 2.00 mm"), qui precede le(s) prochain(s) article(s). Une categorie
        # peut elle-meme etre coupee sur plusieurs lignes (ex: "Couverture
        # 45-333-1000 RAL 7035 - 63/100 - avec\nanti condensation") : si la
        # ligne precedente etait deja une categorie en cours de constitution,
        # on la complete au lieu de l'ecraser.
        if dernier_type == "categorie" and categorie_courante:
            categorie_courante = (categorie_courante + " " + brut).strip()
        else:
            categorie_courante = brut
        dernier_type = "categorie"

    donnees["articles"] = articles
    return donnees


def generer_pdf_sans_prix(donnees: dict, chemin_sortie: Path):
    """Genere un PDF simplifie (memes articles, sans aucun montant/prix) a
    partir des donnees deja extraites. Destine a etre accessible a tous les
    utilisateurs de l'appli, sans exposer les prix presents sur le PDF EBP
    original (reserve Gestionnaire/Administrateur)."""
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 9, f"Commande {donnees.get('numero_commande') or ''}", new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 10)
    if donnees.get("date_commande"):
        pdf.cell(0, 6, f"Date : {donnees['date_commande']}", new_x="LMARGIN", new_y="NEXT")
    if donnees.get("fournisseur"):
        pdf.cell(0, 6, f"Fournisseur : {donnees['fournisseur']}", new_x="LMARGIN", new_y="NEXT")
    if donnees.get("numero_chantier"):
        pdf.cell(0, 6, f"Chantier : {donnees['numero_chantier']}", new_x="LMARGIN", new_y="NEXT")
    if donnees.get("reference_complete"):
        pdf.multi_cell(0, 6, f"Reference : {donnees['reference_complete']}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    largeur_page = pdf.w - 2 * pdf.l_margin
    largeur_desc = largeur_page - 70
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_fill_color(240, 240, 240)
    pdf.cell(largeur_desc, 7, "Description", border=1, fill=True)
    pdf.cell(35, 7, "Unite", border=1, fill=True)
    pdf.cell(35, 7, "Quantite", border=1, fill=True, new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 9)
    categorie_affichee = None
    for art in donnees.get("articles", []):
        categorie = art.get("categorie")
        if categorie and categorie != categorie_affichee:
            pdf.set_font("Helvetica", "B", 9)
            pdf.multi_cell(0, 6, categorie, new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 9)
            categorie_affichee = categorie
        y_avant = pdf.get_y()
        x_avant = pdf.get_x()
        pdf.multi_cell(largeur_desc, 6, art.get("description") or "", border=1, new_x="LEFT", new_y="TOP")
        y_apres = pdf.get_y()
        hauteur = max(y_apres - y_avant, 6)
        pdf.set_xy(x_avant + largeur_desc, y_avant)
        pdf.cell(35, hauteur, art.get("unite") or "", border=1)
        qte = art.get("quantite")
        pdf.cell(35, hauteur, ("" if qte is None else f"{qte:g}"), border=1)
        pdf.set_xy(x_avant, y_avant + hauteur)

    pdf.output(str(chemin_sortie))


# --------------------------------------------------------------------------
# BASEROW
# --------------------------------------------------------------------------

def resoudre_chantier_id(numero_chantier: str, numero_devis: str = None):
    """Cherche l'ID de ligne du chantier dans TABLE_CHANTIERS_ADMIN.
    Le champ CHAMP_NUMERO_CHANTIER contient "CH1170 Nom du chantier..." :
    on compare d'abord les 6 premiers caracteres (le code chantier). Si aucun
    chantier ne matche (code absent/errone), on se rabat sur le numero de
    devis (ex: "DE6482"), recherche n'importe ou dans le meme champ - le
    devis y figure generalement aussi (ex: "CH1170 SAINT FULGENT DE6482-01").
    Filtrage cote client (le champ peut contenir accents/espaces)."""
    if not numero_chantier and not numero_devis:
        return None
    code = numero_chantier.strip()[:6] if numero_chantier else None
    url = f"{BASEROW_URL}/{TABLE_CHANTIERS_ADMIN}/?user_field_names=true&size=200"
    resultat_devis = None
    while url:
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json()
        for row in data["results"]:
            val = str(row.get(CHAMP_NUMERO_CHANTIER, "")).strip()
            if code and val[:6] == code:
                return row["id"]
            if numero_devis and resultat_devis is None and numero_devis in val.replace(" ", ""):
                resultat_devis = row["id"]
        url = data.get("next")
        if url:
            url = url.replace("http://", "https://")
    return resultat_devis


def resoudre_chantier_par_nom(nom_recherche: str):
    """Cherche un chantier dont le champ CHAMP_NUMERO_CHANTIER contient
    nom_recherche (recherche insensible a la casse, n'importe ou dans le
    champ). Utilise pour le chantier de repli STOCK ATELIER."""
    url = f"{BASEROW_URL}/{TABLE_CHANTIERS_ADMIN}/?user_field_names=true&size=200"
    while url:
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json()
        for row in data["results"]:
            val = str(row.get(CHAMP_NUMERO_CHANTIER, "")).strip()
            if nom_recherche.lower() in val.lower():
                return row["id"]
        url = data.get("next")
        if url:
            url = url.replace("http://", "https://")
    return None


def televerser_pdf(pdf_path: Path) -> dict:
    """Televerse le PDF sur Baserow (stockage de fichiers) et retourne
    l'objet fichier ({'name': ...}) a inserer dans le champ File de la
    ligne de commande."""
    headers = {"Authorization": f"Token {BASEROW_TOKEN}"}
    with open(pdf_path, "rb") as f:
        fichiers = {"file": (pdf_path.name, f, "application/pdf")}
        r = requests.post(BASEROW_UPLOAD_URL, headers=headers, files=fichiers, timeout=60)
    r.raise_for_status()
    return r.json()  # contient notamment 'name' (nom genere cote Baserow)


def pousser_commande(donnees: dict, chantier_id, fichier_baserow=None, fichier_sans_prix_baserow=None) -> int:
    """Cree la ligne d'entete de commande. Retourne son ID."""
    payload = {
        "Numero commande": donnees["numero_commande"],
        "Date commande": _reformater_date(donnees["date_commande"]),
        "Fournisseur": donnees["fournisseur"],
        "Numero chantier": donnees["numero_chantier"],
        "Numero devis": donnees["numero_devis"],
        "Designation": donnees["designation"],
        "Reference complete": donnees["reference_complete"],
        "Montant total HT": donnees["total_ht"],
        "Montant total TVA": donnees["total_tva"],
        "Net a payer": donnees["net_a_payer"],
        "Fichier source": donnees["fichier_source"],
        "Statut": "En attente AR",
    }
    if chantier_id:
        payload["Chantier"] = [chantier_id]
    if fichier_baserow:
        payload["PDF"] = [{"name": fichier_baserow["name"]}]
    if fichier_sans_prix_baserow:
        payload["PDF sans prix"] = [{"name": fichier_sans_prix_baserow["name"]}]

    url = f"{BASEROW_URL}/{TABLE_COMMANDES}/?user_field_names=true"
    r = requests.post(url, headers=HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()["id"]


def pousser_lignes(commande_id: int, articles: list):
    url = f"{BASEROW_URL}/{TABLE_COMMANDE_LIGNES}/?user_field_names=true"
    for art in articles:
        payload = {
            "Commande": [commande_id],
            "Categorie": art["categorie"],
            "Reference fournisseur": art["reference_fournisseur"],
            "Description": art["description"],
            "Unite": art["unite"],
            "Quantite": art["quantite"],
            "Deboursé HT": art["debourse_ht"],
            "Montant HT": art["montant_ht"],
            "TVA": art["tva"],
        }
        r = requests.post(url, headers=HEADERS, json=payload, timeout=30)
        r.raise_for_status()


def _reformater_date(date_fr: str):
    """'04/09/2026' -> '2026-09-04' (format attendu par Baserow)."""
    if not date_fr:
        return None
    try:
        return datetime.strptime(date_fr, "%d/%m/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


# --------------------------------------------------------------------------
# SUIVI DES FICHIERS DEJA TRAITES
# --------------------------------------------------------------------------

def charger_traites() -> set:
    if PROCESSED_LOG.exists():
        return set(json.loads(PROCESSED_LOG.read_text(encoding="utf-8")))
    return set()


def sauver_traites(traites: set):
    PROCESSED_LOG.write_text(
        json.dumps(sorted(traites), ensure_ascii=False, indent=2), encoding="utf-8"
    )


# --------------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------------

def executer_scan():
    """Un passage de scan du dossier (utilise a la fois par le mode boucle
    continue et par un lancement manuel ponctuel)."""
    if TABLE_COMMANDES is None or TABLE_COMMANDE_LIGNES is None:
        sys.exit(
            "Merci de renseigner TABLE_COMMANDES et TABLE_COMMANDE_LIGNES "
            "en haut du script (voir instructions Baserow dans l'en-tete)."
        )

    for d in (TRAITE_DIR, ERREUR_DIR):
        d.mkdir(parents=True, exist_ok=True)

    traites = charger_traites()
    pdfs = sorted(WATCH_DIR.glob("*.pdf"))
    nouveaux = [p for p in pdfs if p.name not in traites]

    if not nouveaux:
        return

    for pdf_path in nouveaux:
        print(f"-> Traitement de {pdf_path.name}")
        try:
            donnees = extraire_commande(pdf_path)
            if not donnees["numero_commande"]:
                raise ValueError("Numero de commande introuvable")

            chantier_id = resoudre_chantier_id(donnees["numero_chantier"], donnees.get("numero_devis"))
            if chantier_id is None:
                chantier_id = resoudre_chantier_par_nom(NOM_CHANTIER_STOCK_ATELIER)
                if chantier_id:
                    print(
                        f"   [i] Aucun chantier identifie (code/devis absent ou inconnu) - "
                        f"affectee a '{NOM_CHANTIER_STOCK_ATELIER}'."
                    )
                else:
                    print(
                        f"   [!] Chantier '{donnees['numero_chantier']}' non trouve, et le "
                        f"chantier de repli '{NOM_CHANTIER_STOCK_ATELIER}' est introuvable "
                        f"dans Baserow - commande poussee sans lien chantier."
                    )

            fichier_baserow = televerser_pdf(pdf_path)

            chemin_sans_prix = pdf_path.with_name(pdf_path.stem + "_sans_prix.pdf")
            fichier_sans_prix_baserow = None
            try:
                generer_pdf_sans_prix(donnees, chemin_sans_prix)
                fichier_sans_prix_baserow = televerser_pdf(chemin_sans_prix)
            except Exception as e_pdf:
                print(f"   [!] PDF sans prix non genere/televerse : {e_pdf}")
            finally:
                if chemin_sans_prix.exists():
                    chemin_sans_prix.unlink()

            commande_id = pousser_commande(donnees, chantier_id, fichier_baserow, fichier_sans_prix_baserow)
            pousser_lignes(commande_id, donnees["articles"])

            shutil.move(str(pdf_path), str(TRAITE_DIR / pdf_path.name))
            traites.add(pdf_path.name)
            print(
                f"   OK - {donnees['numero_commande']} / "
                f"chantier {donnees['numero_chantier']} - "
                f"{len(donnees['articles'])} article(s) - {donnees['total_ht']} EUR HT"
            )
        except Exception as e:
            print(f"   ERREUR : {e}")
            shutil.copy(str(pdf_path), str(ERREUR_DIR / pdf_path.name))

    sauver_traites(traites)


def main():
    """Boucle continue : verifie le dossier toutes les INTERVALLE_SECONDES.
    Concu pour etre lance une fois au demarrage de Windows et tourner en
    arriere-plan (voir raccourci lancer_commandes_scan.bat)."""
    print(
        f"Surveillant de commandes demarre - verification toutes les "
        f"{INTERVALLE_SECONDES}s. Ctrl+C pour arreter."
    )
    while True:
        try:
            executer_scan()
        except SystemExit:
            raise
        except Exception as e:
            print(f"Erreur inattendue pendant le scan : {e}")
        time.sleep(INTERVALLE_SECONDES)


if __name__ == "__main__":
    main()
