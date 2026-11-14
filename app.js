// Application « Signaux de marché ».
// Elle lit donnees.json (régénéré chaque soir) et n'envoie rien nulle part :
// le portefeuille saisi par l'utilisateur reste dans la mémoire de son téléphone.

const VERSION = "13/11/2026 15548a7";        // remplacé par le numéro de version au moment de la publication
const contenu = document.getElementById("contenu");
let versionPubliee = null;    // version disponible en ligne (peut être plus récente que celle chargée)
let D = null;                 // données du jour
let onglet = "aujourdhui";
let horizonModele = "5";
let vuePortefeuille = "mien";
let actifChoisi = null;       // actif dont la fiche détaillée est ouverte

// ---------- outils ----------
const pct = (x, d = 1) => x == null ? "—" : (x * 100).toFixed(d).replace(".", ",") + " %";
const nb = (x, d = 2) => x == null ? "—" : x.toFixed(d).replace(".", ",");
const eur = x => x == null ? "—" : x.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const jour = iso => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—";
const h = (balise, attributs = {}, ...enfants) => {
  const e = document.createElement(balise);
  for (const [k, v] of Object.entries(attributs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const enfant of enfants.flat()) if (enfant != null) e.append(enfant);
  return e;
};
const carte = (...enfants) => h("section", { class: "carte" }, ...enfants);
const tableau = (entetes, lignes) => h("div", { class: "defile" }, h("table", {},
  h("thead", {}, h("tr", {}, entetes.map(t => h("th", {}, t)))),
  h("tbody", {}, lignes.map(l => h("tr", {}, l.map(c => h("td", {}, c)))))));

const aide = (titre, ...paragraphes) => h("details", { class: "aide" }, h("summary", {}, titre), paragraphes.map(t => h("p", {}, t)));

// Lecture en clair d'une probabilité par rapport à son niveau habituel.
function verdict(a, horizon = "5") {
  const ecart = a.probas[horizon] - a.probas_habituelles[horizon];
  if (ecart > 0.02) return ["plus", "Plus favorable que d'habitude"];
  if (ecart < -0.02) return ["moins", "Moins favorable que d'habitude"];
  return ["", "Dans la normale"];
}

// Mémoire locale (peut être indisponible en navigation privée : l'appli fonctionne quand même).
const reglage = {
  lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } },
  ecrire(cle, valeur) { try { localStorage.setItem(cle, valeur); } catch { /* sans mémoire */ } },
};
const memoire = {
  lire() { try { return JSON.parse(localStorage.getItem("portefeuille")) || {}; } catch { return {}; } },
  ecrire(p) { try { localStorage.setItem("portefeuille", JSON.stringify(p)); } catch { /* sans mémoire */ } },
};

// ---------- calcul des ordres pour le portefeuille de l'utilisateur ----------
// Frais de courtage estimés d'un ordre, d'après le tarif du courtier (forfait puis pourcentage).
function fraisCourtier(montant) {
  const t = D.reglages.courtier;
  return montant <= t.seuil_fixe ? t.frais_fixe : montant * t.frais_proportionnel;
}

// Méthode suivie : "simple" (un seul ETF Monde, acheté régulièrement) ou "strategie" (les huit ETF du modèle).
function methode(p) {
  if (p.methode) return p.methode;
  const suitDeja = D.actifs.some(a => (p.quantites || {})[a.instrument] > 0);
  return suitDeja ? "strategie" : "simple";
}

// Valeur de tous les titres saisis (ETF du modèle et ETF Monde).
function valeurTitres(p) {
  const q = p.quantites || {};
  return D.actifs.reduce((s, a) => s + (q[a.instrument] || 0) * (a.cours_instrument || 0), 0)
    + (q[D.monde.instrument] || 0) * (D.monde.cours || 0);
}

function ordresPour(portefeuille) {
  const quantites = portefeuille.quantites || {};
  const titres = valeurTitres(portefeuille);
  const total = (portefeuille.liquidites || 0) + titres;
  const ordres = [];
  if (methode(portefeuille) === "simple") {
    // Mode simple : tout ce qui est disponible va dans l'ETF Monde, en un seul ordre.
    const m = D.monde, disponible = portefeuille.liquidites || 0;
    let quantite = m.cours ? Math.floor(disponible / m.cours) : 0;
    while (quantite > 0 && quantite * m.cours + fraisCourtier(quantite * m.cours) > disponible) quantite--;
    if (quantite > 0 && quantite * m.cours >= 50) {
      const montant = quantite * m.cours;
      ordres.push({ sens: "achat", quantite, montant, frais: fraisCourtier(montant), a: { instrument: m.instrument, nom_instrument: m.nom } });
    }
    return { total, titres, ordres };
  }
  for (const a of D.actifs) {
    if (!a.cours_instrument) continue;
    const visee = Math.floor(a.part_visee * total / a.cours_instrument);
    const ecart = visee - (quantites[a.instrument] || 0);
    const montant = Math.abs(ecart) * a.cours_instrument;
    if (ecart !== 0 && montant >= D.reglages.ordre_minimum) {
      ordres.push({ sens: ecart > 0 ? "achat" : "vente", quantite: Math.abs(ecart), montant, frais: fraisCourtier(montant), a });
    }
  }
  ordres.sort((x, y) => (x.sens === "vente" ? 0 : 1) - (y.sens === "vente" ? 0 : 1));
  return { total, titres, ordres };
}

// Historique de la valeur du portefeuille, gardé sur le téléphone : un point par jour de données.
const historique = {
  lire() { try { return JSON.parse(localStorage.getItem("historique")) || []; } catch { return []; } },
  noter(total) {
    const points = historique.lire().filter(pt => pt[0] !== D.date_donnees);
    points.push([D.date_donnees, Math.round(total)]);
    points.sort((x, y) => x[0] < y[0] ? -1 : 1);
    try { localStorage.setItem("historique", JSON.stringify(points.slice(-800))); } catch { /* sans mémoire */ }
    return points;
  },
};

const ligneOrdre = o => h("div", { class: "ordre" },
  h("div", {}, h("span", { class: "sens " + o.sens }, o.sens === "achat" ? "Acheter " : "Vendre "),
    `${o.quantite} × ${o.nom || o.a.nom_instrument}`,
    h("div", { class: "discret" }, o.instrument || o.a.instrument)),
  h("div", { class: "nombre", style: "text-align:right" }, o.montant != null ? "≈ " + eur(o.montant) : (o.prix ? nb(o.prix) + " €" : ""),
    o.frais != null ? h("div", { class: "discret" }, "frais ≈ " + nb(o.frais) + " €") : null));

// ---------- onglet Aujourd'hui ----------
function vueAujourdhui() {
  const b = D.backtest[String(D.reglages.horizon_portefeuille)];
  const strategie = b.lignes.find(l => l.nom.startsWith("Stratégie (frais"));
  const reference = b.lignes.find(l => l.nom === "Exposition constante");
  const blocs = [carte(...[
    h("strong", {}, "À lire avant d'investir"),
    `Depuis 2015, suivre ce modèle n'a pas fait mieux qu'une détention passive : Sharpe de ${nb(strategie.sharpe)} contre ${nb(reference.sharpe)}. `
    + `L'avantage ne tient que dans ${pct(b.proba_mieux, 0)} des scénarios rejoués ; il n'est pas démontré. `
    + "Ces signaux sont une information parmi d'autres, pas une garantie de gain.",
  ])];
  blocs[0].classList.add("alerte");
  if (versionPubliee && VERSION !== "dev" && versionPubliee !== VERSION) {
    blocs.unshift(carte(h("h2", {}, "Nouvelle version disponible"),
      h("p", {}, `Tu utilises la version ${VERSION}. La version ${versionPubliee} est en ligne.`),
      h("button", { class: "action", onclick: mettreAJourApplication }, "Mettre à jour l'application")));
  }
  if (!reglage.lire("bienvenue")) {
    blocs.unshift(carte(h("h2", {}, "Bienvenue"),
      h("p", {}, "Cette application t'aide à décider, elle ne décide pas à ta place. Elle n'a aucun accès à ton argent : c'est toi qui passes les ordres chez ton courtier."),
      h("p", {}, "Prends cinq minutes pour lire le guide avant d'investir le moindre euro."),
      h("button", { class: "action", onclick: () => { reglage.ecrire("bienvenue", "1"); afficher("guide"); } }, "Lire le guide du débutant"),
      h("button", { class: "secondaire", onclick: () => { reglage.ecrire("bienvenue", "1"); afficher("aujourdhui"); } }, "Plus tard")));
  }
  const compte = { plus: 0, moins: 0, "": 0 };
  D.actifs.forEach(a => compte[verdict(a)[0]]++);
  blocs.push(carte(h("h2", {}, "En clair, aujourd'hui"),
    h("p", {}, compte.plus + compte.moins === 0
      ? "Rien de particulier : pour tous les actifs, le modèle est à son niveau habituel. Aucune raison de changer ce que tu fais."
      : `Le modèle est plus favorable que d'habitude sur ${compte.plus} actif(s), moins favorable sur ${compte.moins}, et dans la normale sur ${compte[""]}.`),
    h("p", { class: "discret" }, `Marché américain : ${D.regime.actuel.toLowerCase()} depuis ${D.regime.depuis} séances.`),
    aide("Que dois-je faire de cette information ?",
      "Rien d'urgent, jamais. Ces probabilités bougent peu d'un jour à l'autre et le modèle n'a pas prouvé qu'il bat un placement passif.",
      "Si tu suis la stratégie : regarde « Mes ordres du jour » une fois par semaine, pas plus. Si tu investis simplement tous les mois, tu peux ignorer ces signaux.")));

  const p = memoire.lire();
  if (p.liquidites != null) {
    const { total, ordres } = ordresPour(p);
    blocs.push(carte(h("h2", {}, "Mes ordres du jour"),
      h("p", { class: "discret" }, methode(p) === "simple"
        ? `Portefeuille estimé : ${eur(total)}. Méthode simple : un achat par mois suffit.`
        : `Portefeuille estimé : ${eur(total)}. À passer à la prochaine ouverture.`),
      ordres.length ? ordres.map(ligneOrdre) : h("p", {}, "Aucun ordre : ton portefeuille est déjà aligné sur les positions visées."),
      aide("Comment lire cette liste ?",
        "Chaque ligne est un ordre à passer toi-même chez ton courtier pour rapprocher ton portefeuille de la répartition que suit la stratégie.",
        "Tu n'es jamais obligé de les passer. Les suivre tous les jours coûte des frais : une fois par semaine suffit largement.",
        "Une fois les ordres passés, va dans l'onglet Portefeuille et touche « J'ai passé ces ordres » pour mettre tes quantités à jour.")));
  } else {
    blocs.push(carte(h("h2", {}, "Mes ordres du jour"),
      h("p", {}, "Indique ton capital dans l'onglet Portefeuille pour obtenir la liste d'ordres à passer."),
      h("button", { class: "action", onclick: () => afficher("portefeuille") }, "Renseigner mon portefeuille")));
  }

  blocs.push(carte(h("h2", {}, "Depuis hier"),
    D.changements.length ? h("ul", { class: "regles" }, D.changements.map(c => h("li", {}, c)))
                         : h("p", { class: "discret" }, "Rien de notable : les probabilités ont à peine bougé et le régime de marché est le même.")));

  const alertes = D.etat.filter(c => !c.ok);
  blocs.push(carte(h("h2", {}, "État des données"),
    alertes.length
      ? [h("p", {}, h("strong", {}, `${alertes.length} contrôle(s) en alerte. `), "Les signaux du jour sont à prendre avec prudence."),
         ...alertes.map(c => h("div", { class: "ordre" }, h("div", {}, h("span", { class: "sens vente" }, c.nom), h("div", { class: "discret" }, c.detail))))]
      : h("p", { class: "discret" }, `Les ${D.etat.length} contrôles sont au vert : prix, macro, météo, actualités et prédictions sont à jour.`)));

  blocs.push(h("h2", {}, "Probabilités de hausse"));
  for (const a of [...D.actifs].sort((x, y) => y.probas["5"] - x.probas["5"])) {
    const proba = a.probas["5"], habituelle = a.probas_habituelles["5"];
    // Jauge de 40 % à 70 % : c'est la plage où vivent ces probabilités.
    const position = x => Math.max(0, Math.min(100, (x - 0.4) / 0.3 * 100)) + "%";
    blocs.push(carte(
      h("div", { class: "ligne" }, h("span", { class: "actif-nom" }, a.nom), h("span", { class: "grand" }, pct(proba))),
      h("div", { class: "discret" }, `à 5 séances · via ${a.nom_instrument} (${a.instrument})`),
      h("div", { style: "margin-top:6px" }, h("span", { class: "verdict " + verdict(a)[0] }, verdict(a)[1])),
      h("div", { class: "jauge", role: "img", "aria-label": `Probabilité ${pct(proba)}, habituelle ${pct(habituelle)}` },
        h("i", { style: "width:" + position(proba) }), h("b", { style: "left:" + position(habituelle), title: "Niveau habituel" })),
      h("div", { class: "petits" },
        h("span", {}, "Habituelle ", h("b", {}, pct(habituelle))),
        h("span", {}, "J+1 ", h("b", {}, pct(a.probas["1"]))),
        h("span", {}, "J+21 ", h("b", {}, pct(a.probas["21"]))),
        h("span", {}, "Part visée ", h("b", {}, pct(a.part_visee))),
        h("span", {}, "Variation normale 5 j ", h("b", {}, "± " + pct(a.amplitude_5)))),
      h("button", { class: "secondaire", onclick: () => { actifChoisi = a.actif; afficher("actif"); } }, "Voir la fiche détaillée")));
  }
  blocs.push(carte(h("p", { class: "discret" }, "Le trait vertical marque la probabilité habituelle de l'actif : au-delà, le modèle est plus optimiste que d'ordinaire."),
    aide("Pourquoi toutes les probabilités dépassent 50 % ?",
      "Parce que les marchés actions montent un peu plus souvent qu'ils ne baissent : environ 55 à 60 % du temps sur une semaine. Une probabilité de 58 % n'est donc pas un signal d'achat, c'est presque la situation ordinaire.",
      "Ce qui compte, c'est l'écart avec la probabilité habituelle. L'étiquette à droite de chaque actif le résume.")));
  return blocs;
}

// ---------- onglet Portefeuille ----------
function vuePortefeuilleEcran() {
  const choix = h("div", { class: "segments" },
    ...[["mien", "Le mien"], ["simulation", "Simulation auto"]].map(([cle, nom]) =>
      h("button", { class: vuePortefeuille === cle ? "actif" : "", onclick: () => { vuePortefeuille = cle; afficher("portefeuille"); } }, nom)));
  return [choix, ...(vuePortefeuille === "mien" ? vueMien() : vueSimulation())];
}

function vueMien() {
  const p = memoire.lire();
  p.quantites = p.quantites || {};
  const simple = methode(p) === "simple";
  const resultat = h("div");
  const calculer = () => {
    resultat.replaceChildren();
    if (p.liquidites == null) return;
    const { total, titres, ordres } = ordresPour(p);
    const points = historique.noter(total);
    const gain = p.verse ? total - p.verse : null;
    resultat.append(carte(h("h2", {}, "Ma situation"),
      h("div", { class: "ligne" }, h("span", {}, "Valeur du portefeuille"), h("span", { class: "grand" }, eur(total))),
      h("div", { class: "petits" },
        h("span", {}, "Titres ", h("b", {}, eur(titres))), h("span", {}, "Liquidités ", h("b", {}, eur(p.liquidites))),
        gain != null ? h("span", {}, gain >= 0 ? "Gain " : "Perte ", h("b", { style: `color:var(--${gain >= 0 ? "bon" : "mauvais"})` },
          `${eur(Math.abs(gain))} (${pct(gain / p.verse)})`)) : null),
      points.length >= 3 ? courbe(points.map(pt => pt[0]), [{ nom: "Mon portefeuille", couleur: "--serie-1", valeurs: points.map(pt => pt[1]) }], false, eur)
                         : h("p", { class: "discret", style: "margin-top:8px" }, "La courbe de ton portefeuille se dessinera au fil des jours où tu ouvres l'application."),
      aide("Comment lire ma situation ?",
        "La valeur est calculée avec les derniers cours connus et ce que tu as saisi. Le gain ou la perte compare cette valeur au total que tu as versé.",
        "Une perte affichée n'est pas une perte réelle tant que tu ne vends pas. Sur un placement en actions, regarder ce chiffre tous les jours ne sert à rien : une fois par mois suffit.")));
    resultat.append(carte(h("h2", {}, simple ? "Mon achat du mois" : "Ordres à passer"),
      h("p", { class: "discret" }, `Total ${eur(total)} · titres ${eur(titres)} · liquidités ${eur(p.liquidites)}`),
      ordres.length ? ordres.map(ligneOrdre) : h("p", {}, "Rien à faire : positions déjà alignées."),
      ordres.length ? h("button", { class: "action", onclick: () => {
        // Met à jour les quantités et les liquidités comme si les ordres avaient été exécutés au dernier cours.
        for (const o of ordres) {
          const signe = o.sens === "achat" ? 1 : -1;
          p.quantites[o.a.instrument] = (p.quantites[o.a.instrument] || 0) + signe * o.quantite;
          p.liquidites -= signe * o.montant + o.frais;
        }
        p.liquidites = Math.max(0, Math.round(p.liquidites));
        memoire.ecrire(p); afficher("portefeuille");
      } }, "J'ai passé ces ordres") : null,
      h("p", { class: "discret", style: "margin-top:10px" },
        (simple ? "" : `Ordres inférieurs à ${eur(D.reglages.ordre_minimum)} ignorés (les frais pèseraient trop). `)
        + `Frais estimés d'après le tarif ${D.reglages.courtier.nom} : `
        + `${nb(D.reglages.courtier.frais_fixe)} € jusqu'à ${eur(D.reglages.courtier.seuil_fixe)}, ${pct(D.reglages.courtier.frais_proportionnel)} au-delà ; `
        + "ils peuvent être nuls sur certains ETF (offre BoursoMarkets, à vérifier dans ton appli). Quantités calculées sur le dernier cours connu ; "
        + "le prix réel sera un peu différent : corrige ensuite les liquidités avec le montant affiché par ton courtier."),
      simple ? h("p", { class: "discret" }, "Méthode simple : verse la même somme chaque mois et achète l'ETF Monde, quelle que soit l'actualité. "
        + (ordres.length && ordres[0].frais / ordres[0].montant > 0.01
            ? "Attention : les frais dépassent 1 % de cet achat. Regrouper deux ou trois mois de versements en un seul ordre coûte moins cher." : "")) : null,
      !simple && total < 5000 ? h("p", { class: "discret" }, h("strong", {}, "Petit portefeuille : "),
        "en dessous de 5 000 €, répartir sur huit ETF donne des ordres trop petits pour être passés sans que les frais mangent le résultat. "
        + "Un seul ETF mondial acheté une fois par mois est plus adapté (voir le guide).") : null,
      aide("Comment passer un ordre chez mon courtier ?",
        "1. Dans l'appli BoursoBank, onglet Bourse : cherche l'ETF avec son code (par exemple PSP5) et vérifie que le nom correspond.",
        "2. Choisis « Acheter » ou « Vendre », saisis la quantité indiquée ici.",
        "3. Type d'ordre : « à cours limité », avec comme limite le prix affiché plus 0,5 % pour un achat (moins 0,5 % pour une vente). Cela évite d'acheter beaucoup plus cher que prévu.",
        "4. Passe l'ordre pendant la séance (9 h – 17 h 30), puis reviens ici toucher « J'ai passé ces ordres ».")));
    if (titres > 0 && !simple) resultat.append(carte(h("h2", {}, "Ma répartition"),
      tableau(["ETF", "Actuelle", "Visée"], D.actifs.map(a =>
        [a.nom_instrument, pct((p.quantites[a.instrument] || 0) * a.cours_instrument / total), pct(a.part_visee)])),
      h("p", { class: "discret", style: "margin-top:8px" }, `Liquidités : ${pct(p.liquidites / total)} du portefeuille.`)));
  };
  const champ = (libelle, sous, valeur, enregistrer, pas) => {
    const entree = h("input", { type: "number", inputmode: "decimal", min: "0", step: pas, value: valeur ?? "", placeholder: "0" });
    entree.addEventListener("input", () => { enregistrer(entree.value === "" ? null : Number(entree.value)); memoire.ecrire(p); calculer(); });
    return h("label", { class: "champ" }, h("span", {}, libelle, sous ? h("small", {}, sous) : null), entree);
  };
  const choisir = cle => { p.methode = cle; memoire.ecrire(p); afficher("portefeuille"); };
  const choixMethode = carte(h("h2", {}, "Ma méthode"),
    h("div", { class: "segments", style: "margin-bottom:8px" },
      h("button", { class: simple ? "actif" : "", onclick: () => choisir("simple") }, "Simple"),
      h("button", { class: simple ? "" : "actif", onclick: () => choisir("strategie") }, "Stratégie")),
    h("p", { class: "discret" }, simple
      ? `Un seul ETF très diversifié (${D.monde.nom}, code ${D.monde.instrument.replace(".PA", "")}), acheté régulièrement. C'est la méthode que les chiffres soutiennent le mieux.`
      : "Les huit ETF du modèle, avec des parts qui varient selon ses probabilités. Demande plus de capital, plus d'ordres, et n'a pas prouvé qu'elle fait mieux."));
  const detenus = simple
    ? [champ(D.monde.nom, `${D.monde.instrument} · ${nb(D.monde.cours)} € la part`, p.quantites[D.monde.instrument], v => { p.quantites[D.monde.instrument] = v || 0; }, "1")]
    : D.actifs.map(a => champ(a.nom_instrument, `${a.instrument} · ${nb(a.cours_instrument)} € la part`,
        p.quantites[a.instrument], v => { p.quantites[a.instrument] = v || 0; }, "1"));
  const saisie = carte(h("h2", {}, "Mon portefeuille"),
    h("p", { class: "discret", style: "margin-bottom:8px" }, "Ces montants restent sur ce téléphone. Rien n'est envoyé."),
    champ("Liquidités disponibles (€)", "argent non investi sur le compte", p.liquidites, v => { p.liquidites = v; }, "10"),
    champ("Total versé depuis le début (€)", "facultatif : sert à calculer ton gain", p.verse, v => { p.verse = v; }, "10"),
    h("h3", {}, "Parts détenues"), ...detenus);
  calculer();
  return [choixMethode, saisie, resultat];
}

function vueSimulation() {
  const s = D.simulation;
  const dernier = s.valeur[s.valeur.length - 1];
  const blocs = [carte(h("h2", {}, "Portefeuille automatique fictif"),
    h("p", { class: "discret" }, `Argent fictif, vrais prix. Le moteur passe seul ses ordres chaque soir depuis le ${jour(s.valeur[0]?.date)}.`),
    h("div", { class: "ligne" }, h("span", {}, "Valeur"), h("span", { class: "grand" }, eur(dernier?.total))),
    h("div", { class: "petits" },
      h("span", {}, "Départ ", h("b", {}, eur(s.capital_initial))),
      h("span", {}, "Référence passive ", h("b", {}, eur(dernier?.reference))),
      h("span", {}, "Liquidités ", h("b", {}, eur(s.liquidites)))),
    aide("À quoi sert ce portefeuille fictif ?",
      "C'est un test grandeur nature sans risque : le moteur suit la stratégie tout seul avec de l'argent virtuel, aux vrais prix, frais compris.",
      "Compare sa valeur à la « référence passive » (le même argent placé une fois pour toutes). Si après plusieurs mois il ne fait pas mieux, la stratégie ne vaut pas la peine d'être suivie avec ton argent."))];
  if (s.valeur.length > 2) {
    blocs.push(carte(h("h2", {}, "Évolution"), courbe(s.valeur.map(v => v.date),
      [{ nom: "Portefeuille", couleur: "--serie-1", valeurs: s.valeur.map(v => v.total) },
       { nom: "Référence passive", couleur: "--serie-2", valeurs: s.valeur.map(v => v.reference) }], false)));
  } else {
    blocs.push(carte(h("p", { class: "discret" }, "La courbe apparaîtra après quelques jours de fonctionnement.")));
  }
  if (s.positions.length) blocs.push(carte(h("h2", {}, "Positions"),
    tableau(["ETF", "Parts", "Cours", "Valeur"], s.positions.map(p => [p.nom, p.quantite, nb(p.cours) + " €", eur(p.valeur)]))));
  blocs.push(carte(h("h2", {}, "Ordres en attente"),
    s.ordres_en_attente.length ? s.ordres_en_attente.map(ligneOrdre) : h("p", { class: "discret" }, "Aucun.")));
  if (s.ordres_executes.length) blocs.push(carte(h("h2", {}, "Derniers ordres exécutés"),
    tableau(["Date", "Ordre", "Prix"], s.ordres_executes.map(o =>
      [jour(o.date_execution), `${o.sens === "achat" ? "Achat" : "Vente"} ${o.quantite} × ${o.nom}`, nb(o.prix) + " €"]))));
  return blocs;
}

// ---------- onglet Marché ----------
function vueMarche() {
  const r = D.regime, c = D.correlations;
  const barres = h("div", { class: "barres" }, ...Object.entries(r.dans_un_mois).flatMap(([nom, v]) =>
    [h("span", {}, nom), h("div", { class: "piste" }, h("i", { style: `width:${v * 100}%` })), h("span", { class: "nombre" }, pct(v, 0))]));
  const regime = carte(h("h2", {}, "Régime de marché"),
    h("div", { class: "ligne" }, h("span", { class: "grand" }, r.actuel), h("span", { class: "discret" }, `depuis ${r.depuis} séances`)),
    h("p", { class: "discret", style: "margin:6px 0 12px" }, "Tendance du S&P 500 (au-dessus ou non de sa moyenne 200 jours) et agitation (volatilité au-dessus ou non de sa médiane sur 3 ans)."),
    aide("Comprendre le régime",
      "« Haussier » : le marché est au-dessus de sa tendance de fond. « Agité » : il bouge plus que d'habitude. Un marché haussier et calme est la situation la plus fréquente et la plus confortable.",
      "Le régime change lentement. Il ne dit pas quoi acheter : il donne le contexte, et rappelle qu'en période agitée les pertes d'un jour peuvent être plus fortes."),
    h("h3", {}, "Régime probable dans un mois"), barres,
    h("h3", {}, "Ce qui a suivi chaque régime"),
    tableau(["Régime", "Fréquence", "Rendement à 21 j", "Hausses"], r.statistiques.map(s =>
      [s.regime, pct(s.frequence, 0), pct(s.rendement), pct(s.hausse, 0)])),
    h("h3", {}, "Matrice de transition (d'une séance à la suivante)"),
    tableau(["De \\ vers", ...r.noms.map(n => n.replace("Haussier", "Hauss.").replace("Baissier", "Baiss."))],
      r.transition.map((ligne, i) => [r.noms[i], ...ligne.map(v => pct(v, 1))])));

  const n = c.noms.length;
  const teinte = v => { const i = Math.max(0, Math.min(4, Math.round(v * 4))); return `var(--rampe-${i})`; };
  const grille = h("div", { class: "grille-corr", style: `grid-template-columns: 78px repeat(${n}, 1fr)` },
    h("div", { class: "tete" }), ...c.noms.map(nom => h("div", { class: "tete haut" }, nom)),
    ...c.matrice.flatMap((ligne, i) => [h("div", { class: "tete" }, c.noms[i]),
      ...ligne.map(v => h("div", { style: `background:${teinte(v)};color:${v > 0.62 ? "var(--surface)" : "var(--texte)"}` }, nb(v).replace("0,", ",")))]));
  const gain = 1 - c.volatilite_portefeuille / c.volatilite_moyenne_actifs;
  const correlations = carte(h("h2", {}, "Corrélations"),
    h("p", { class: "discret", style: "margin-bottom:10px" }, "Rendements hebdomadaires sur 2 ans. Plus la case est foncée, plus les deux actifs bougent ensemble."),
    grille,
    h("p", { style: "margin-top:12px" }, `Corrélation moyenne : ${nb(c.moyenne)} (moyenne historique ${nb(c.moyenne_historique)}). `
      + `Répartir à parts égales retire ${pct(gain, 0)} du risque par rapport à un actif seul.`),
    aide("Pourquoi regarder les corrélations ?",
      "Diversifier ne sert que si les placements ne bougent pas tous ensemble. Deux actifs corrélés à 0,90 se comportent presque comme un seul.",
      "Ici, toutes les cases sont des actions : elles chutent ensemble dans les grandes crises. Une vraie diversification demande aussi autre chose que des actions (fonds en euros, livrets, obligations)."));

  const risque = carte(h("h2", {}, "Risque par actif"),
    tableau(["Actif", "Volatilité prévue", "Mauvais jour (VaR 95 %)", "Pires jours (CVaR)", "Pire repli 1 an"],
      D.actifs.map(a => [a.nom, pct(a.volatilite_prevue), "−" + pct(a.var_95), "−" + pct(a.cvar_95), pct(a.repli_1_an)])),
    h("p", { class: "discret", style: "margin-top:8px" }, "Un jour sur vingt, la perte dépasse la VaR ; ces jours-là elle vaut en moyenne la CVaR."),
    aide("Combien puis-je perdre ?",
      "Regarde la colonne « Pire repli 1 an » : c'est la plus forte baisse subie par l'actif sur l'année écoulée. Sur dix ans, un indice actions a déjà perdu 30 % et plus.",
      "Règle simple : n'investis en actions que l'argent dont tu peux supporter de voir la valeur baisser d'un tiers pendant plusieurs années sans avoir besoin de le retirer."));
  return [regime, correlations, risque];
}

// ---------- onglet Modèle ----------
function vueModele() {
  const m = D.modele[horizonModele], b = D.backtest[horizonModele];
  const choix = h("div", { class: "segments" }, ...D.horizons.map(x =>
    h("button", { class: String(x) === horizonModele ? "actif" : "", onclick: () => { horizonModele = String(x); afficher("modele"); } }, "J+" + x)));
  const sur = m.auc_bas > 0.5;
  const fiabilite = carte(h("h2", {}, "Fiabilité des probabilités"),
    h("div", { class: "ligne" }, h("span", {}, "AUC (0,5 = hasard)"), h("span", { class: "grand" }, nb(m.auc, 3))),
    h("p", { class: "discret" }, `Intervalle à 90 % : ${nb(m.auc_bas, 3)} à ${nb(m.auc_haut, 3)}. `
      + (sur ? "Le signal est distinct du hasard, mais faible." : "On ne peut pas exclure le hasard.")),
    h("h3", {}, "Annoncé contre constaté"),
    tableau(["Tranche", "Proba. annoncée", "Hausse constatée"], m.calibration.map((t, i) => [i + 1, pct(t[0]), pct(t[1])])),
    h("p", { class: "discret", style: "margin-top:8px" },
      `Quand le modèle est optimiste, le prix a monté ${pct(m.hausse_si_optimiste)} du temps ; quand il est prudent, ${pct(m.hausse_si_prudent)}. `
      + `Sur ${m.predictions.toLocaleString("fr-FR")} prédictions hors échantillon.`),
    aide("Comment savoir si le modèle est fiable ?",
      "L'AUC mesure sa capacité à distinguer les hausses des baisses : 0,50 = pile ou face, 1 = parfait. En bourse, 0,53 est déjà un signal, mais très mince.",
      "Le tableau compare ce que le modèle annonçait à ce qui s'est produit. Si les deux colonnes se suivent, ses probabilités sont honnêtes."));

  const c = b.courbe;
  const backtest = carte(h("h2", {}, "Backtest depuis 2015"),
    courbe(c.dates, [
      { nom: "Stratégie (frais inclus)", couleur: "--serie-1", valeurs: c.strategie },
      { nom: "Achat et conservation", couleur: "--serie-2", valeurs: c.achat_conservation },
      { nom: "Exposition constante", couleur: "--serie-3", valeurs: c.exposition_constante }], true),
    tableau(["", "Rendement / an", "Volatilité", "Sharpe", "Pire baisse"], b.lignes.map(l =>
      [l.nom, pct(l.rendement_annuel), pct(l.volatilite), nb(l.sharpe), pct(l.perte_max)])),
    h("p", { class: "discret", style: "margin-top:8px" },
      `Part investie en moyenne : ${pct(b.exposition_moyenne, 0)}. En rejouant l'histoire 2 000 fois, la stratégie garde un meilleur Sharpe `
      + `que l'exposition constante dans ${pct(b.proba_mieux, 0)} des cas. En dessous de 95 %, l'avantage n'est pas démontré.`),
    aide("Comment lire ce tableau ?",
      "Le Sharpe est le chiffre à comparer : c'est le gain obtenu pour chaque unité de risque. Plus il est haut, mieux c'est.",
      "« Exposition constante » est la comparaison honnête : même part investie que la stratégie, mais sans choisir ses jours. Si la stratégie n'a pas un meilleur Sharpe, le modèle n'apporte rien.",
      "« Achat et conservation » rapporte plus, mais en restant investi à 100 % : il secoue davantage."));

  const annees = carte(h("h2", {}, "Année par année"),
    h("p", { class: "discret", style: "margin-bottom:8px" }, "Un signal solide ne doit pas reposer sur une seule période."),
    tableau(["Année", "AUC", "Stratégie", "Expo. constante", "Achat-conserv."], b.par_annee.map(a =>
      [a.annee, nb(a.auc, 3), pct(a.strategie), pct(a.exposition_constante), pct(a.achat_conservation)])));

  const etf = carte(h("h2", {}, "Sur les ETF réellement achetables"),
    h("p", { class: "discret", style: "margin-bottom:8px" },
      `Mêmes signaux, ordres exécutés à Paris sur les ETF du PEA, en euros, depuis le ${jour(b.instruments.depuis)}. Ce test inclut le change et le décalage horaire.`),
    tableau(["", "Rendement / an", "Volatilité", "Sharpe", "Pire baisse"], b.instruments.lignes.map(l =>
      [l.nom, pct(l.rendement_annuel), pct(l.volatilite), nb(l.sharpe), pct(l.perte_max)])));

  const s = D.suivi[horizonModele];
  const suivi = carte(h("h2", {}, "Suivi en conditions réelles"),
    h("p", { class: "discret", style: "margin-bottom:8px" }, "Prédictions calculées le soir même, avant de connaître la suite. Rien n'y est recalculé après coup."),
    h("div", { class: "petits" },
      h("span", {}, "Vérifiées ", h("b", {}, s.resolues)),
      h("span", {}, "En attente ", h("b", {}, s.en_attente)),
      s.resolues ? h("span", {}, "Annoncé ", h("b", {}, pct(s.proba_moyenne))) : null,
      s.resolues ? h("span", {}, "Constaté ", h("b", {}, pct(s.hausse_constatee))) : null,
      s.resolues ? h("span", {}, "Erreur ", h("b", {}, nb(s.erreur, 4)), " (référence ", h("b", {}, nb(s.erreur_reference, 4)), ")") : null),
    h("p", { class: "discret", style: "margin-top:8px" }, s.resolues < 200
      ? "Trop peu de prédictions vérifiées pour conclure : il en faut plusieurs centaines."
      : (s.erreur < s.erreur_reference ? "L'erreur du modèle est inférieure à celle de la référence." : "Le modèle ne fait pas mieux que la référence.")));

  const maxi = Math.max(...D.importance.map(i => Math.abs(i.coefficient)));
  const importance = carte(h("h2", {}, "Ce qui pèse dans le modèle (J+5)"),
    h("div", { class: "barres" }, ...D.importance.flatMap(i =>
      [h("span", {}, i.variable), h("div", { class: "piste", style: "min-width:60px" }, h("i", { style: `width:${Math.abs(i.coefficient) / maxi * 100}%` })),
       h("span", { class: "nombre" }, i.coefficient > 0 ? "hausse" : "baisse")])),
    h("p", { class: "discret", style: "margin-top:10px" }, "Description du modèle, pas loi du marché : ces liens sont faibles et changent avec le temps."));
  return [choix, fiabilite, suivi, backtest, annees, etf, importance];
}

// ---------- onglet Actus ----------
function vueActus() {
  const libelles = { "-2": "très négatif", "-1": "négatif", "0": "neutre", "1": "positif", "2": "très positif" };
  const etat = carte(h("p", { class: "discret" }, D.jours_actualites >= D.jours_actualites_requis
    ? "Les actualités analysées entrent dans le modèle."
    : `Les actualités n'entrent pas encore dans le modèle : ${D.jours_actualites} jour(s) d'historique sur ${D.jours_actualites_requis} nécessaires. Elles sont affichées à titre d'information.`));
  if (!D.actualites.length) return [etat, carte(h("p", {}, "Aucun événement marquant analysé sur les dernières 36 heures."))];
  return [etat, carte(h("h2", {}, "Événements marquants (36 h)"), ...D.actualites.map(a => h("div", { class: "actu" },
    h("div", { class: "titre" }, a.titre),
    h("div", { class: "petits", style: "margin-top:6px;align-items:center" },
      h("span", { class: "etiquette " + (a.sentiment > 0 ? "pos" : a.sentiment < 0 ? "neg" : "") }, libelles[a.sentiment]),
      h("span", {}, "Intensité ", h("b", {}, a.intensite + "/5")),
      h("span", {}, a.categorie.replace("_", " ")),
      a.editeur ? h("span", {}, a.editeur) : null))))];
}

// ---------- fiche détaillée d'un actif ----------
function vueActif() {
  const a = D.actifs.find(x => x.actif === actifChoisi) || D.actifs[0];
  const hist = a.historique, v = verdict(a);
  const avecProba = hist.dates.map((d, i) => [d, hist.probas[i]]).filter(x => x[1] != null);
  const variation = hist.cours.length > 1 ? hist.cours[hist.cours.length - 1] / hist.cours[0] - 1 : null;
  return [
    h("button", { class: "secondaire", style: "margin:0 0 12px", onclick: () => afficher("aujourdhui") }, "← Retour"),
    carte(h("h2", {}, a.nom), h("p", { class: "discret" }, `S'achète via ${a.nom_instrument} (code ${a.instrument.replace(".PA", "")})`),
      h("div", { class: "ligne" }, h("span", {}, "Probabilité de hausse à 5 séances"), h("span", { class: "grand" }, pct(a.probas["5"]))),
      h("div", { style: "margin:6px 0 10px" }, h("span", { class: "verdict " + v[0] }, v[1])),
      h("div", { class: "petits" },
        h("span", {}, "Habituelle ", h("b", {}, pct(a.probas_habituelles["5"]))),
        h("span", {}, "J+1 ", h("b", {}, pct(a.probas["1"]))), h("span", {}, "J+21 ", h("b", {}, pct(a.probas["21"]))),
        h("span", {}, "Part visée ", h("b", {}, pct(a.part_visee))))),
    carte(h("h2", {}, "Cours de l'ETF sur un an"),
      courbe(hist.dates, [{ nom: "Cours (€)", couleur: "--serie-1", valeurs: hist.cours }], false, x => nb(x, 2)),
      h("p", { class: "discret" }, `Variation sur la période : ${variation == null ? "—" : (variation >= 0 ? "+" : "") + pct(variation)}.`)),
    avecProba.length > 2 ? carte(h("h2", {}, "Probabilité de hausse dans le temps"),
      courbe(avecProba.map(x => x[0]), [{ nom: "Probabilité à 5 séances", couleur: "--serie-2", valeurs: avecProba.map(x => x[1]) }], false, x => pct(x)),
      aide("Que montre cette courbe ?",
        "Elle retrace ce que le modèle annonçait chaque soir. Tu verras qu'elle bouge peu et reste presque toujours entre 50 % et 65 % : le modèle n'a jamais de certitude.",
        "Un creux marqué correspond à une période où il jugeait le marché moins favorable que d'habitude.")) : null,
    carte(h("h2", {}, "Risque"),
      tableau(["Mesure", "Valeur"], [
        ["Volatilité prévue (par an)", pct(a.volatilite_prevue)], ["Perte d'un mauvais jour (VaR 95 %)", "−" + pct(a.var_95)],
        ["Perte moyenne des pires jours", "−" + pct(a.cvar_95)], ["Variation normale sur 5 séances", "± " + pct(a.amplitude_5)],
        ["Pire repli sur un an", pct(a.repli_1_an)], ["Mise demi-Kelly", pct(a.demi_kelly, 0)]]),
      aide("Comment utiliser ces chiffres ?",
        "Ils disent ce que l'actif peut te faire perdre, quelle que soit la prévision. Plus la volatilité est haute, plus la valeur de ta position peut varier d'un jour à l'autre.",
        "La mise demi-Kelly est un plafond théorique de la part du capital à y consacrer ; elle suppose que la probabilité du modèle est exacte, ce qui n'est jamais tout à fait vrai."))];
}

// ---------- guide du débutant ----------
function vueGuide() {
  const liste = (classe, elements) => h(classe === "etapes" ? "ol" : "ul", { class: classe }, elements.map(e => h("li", {}, e)));
  const lexique = [
    ["ETF", "Un panier d'actions acheté en une fois. Un ETF « S&P 500 » contient les 500 plus grandes entreprises américaines."],
    ["PEA", "Enveloppe fiscale française pour investir en actions et ETF européens ou éligibles. Après 5 ans, les gains ne supportent plus que les prélèvements sociaux."],
    ["Ordre à cours limité", "Ordre d'achat ou de vente avec un prix maximum (ou minimum) que tu fixes. Il protège contre une mauvaise surprise à l'exécution."],
    ["Probabilité de hausse", "Sur 100 situations semblables par le passé, nombre de fois où le prix a monté ensuite."],
    ["Volatilité", "Ampleur habituelle des variations. Plus elle est élevée, plus ça secoue."],
    ["Sharpe", "Gain obtenu pour chaque unité de risque. Sert à comparer deux façons d'investir."],
    ["Pire baisse / repli", "Plus forte chute entre un sommet et le creux qui a suivi."],
    ["Backtest", "Simulation de ce qu'aurait donné une stratégie dans le passé. Indicatif, jamais une promesse."],
    ["Détention passive", "Acheter et garder, sans chercher à choisir ses moments. C'est la référence à battre."],
  ];
  return [h("div", { class: "guide" },
    carte(h("h2", {}, "L'essentiel"),
      liste("regles", [
        "L'application calcule chaque soir, pour huit grands indices, la probabilité qu'ils montent.",
        "Elle n'a aucun accès à ton argent. C'est toujours toi qui passes les ordres, chez ton courtier.",
        "Depuis 2015, suivre ses signaux n'a pas rapporté plus qu'un placement passif. Considère-la comme un tableau de bord, pas comme un pilote automatique.",
        "Tout ce que tu saisis (capital, quantités) reste sur ce téléphone.",
      ])),
    carte(h("h2", {}, "Les règles de sécurité"),
      liste("regles", [
        h("span", {}, h("strong", {}, "Épargne de précaution d'abord. "), "Garde 3 à 6 mois de dépenses sur un livret avant d'investir."),
        h("span", {}, h("strong", {}, "Seulement l'argent dont tu n'as pas besoin avant 5 ans. "), "Les actions peuvent perdre un tiers de leur valeur et mettre des années à remonter."),
        h("span", {}, h("strong", {}, "Jamais d'argent emprunté, "), "ni de produits à effet de levier."),
        h("span", {}, h("strong", {}, "Commence petit. "), "Investis une petite somme, observe quelques mois, augmente ensuite."),
        h("span", {}, h("strong", {}, "Ne vends pas dans la panique. "), "Les baisses font partie du chemin ; c'est en vendant au creux qu'on perd vraiment."),
        h("span", {}, h("strong", {}, "Surveille les frais. "), "Chaque ordre coûte. Moins tu en passes, mieux tu te portes."),
      ])),
    carte(h("h2", {}, "La voie la plus simple pour débuter"),
      h("p", {}, "Honnêtement, c'est celle que les chiffres de cette application soutiennent le mieux :"),
      liste("etapes", [
        "Ouvre un PEA chez BoursoBank, depuis ton appli (tu y es déjà client) : aucun droit de garde.",
        "Programme un versement automatique chaque mois, d'un montant que tu ne regretteras pas.",
        "Dans l'onglet Portefeuille, choisis la méthode « Simple » : l'application te dit combien de parts de l'ETF Monde acheter.",
        "Ne touche à rien pendant des années. Consulte cette application par curiosité, pas pour agir.",
      ]),
      h("p", { class: "discret", style: "margin-top:8px" }, "C'est ennuyeux, peu coûteux, et c'est ce qui a le mieux fonctionné historiquement.")),
    carte(h("h2", {}, "Si tu veux suivre la stratégie de l'application"),
      liste("etapes", [
        "Laisse d'abord tourner le « portefeuille fictif » (onglet Portefeuille → Simulation auto) quelques semaines et compare-le à sa référence passive.",
        "Prévois au moins 5 000 € : en dessous, les ordres sont trop petits et les frais pèsent trop.",
        "Onglet Portefeuille → Le mien : saisis tes liquidités. L'application calcule les ordres.",
        "Passe-les chez ton courtier, à cours limité, pendant la séance.",
        "Touche « J'ai passé ces ordres », puis corrige les liquidités d'après ton relevé.",
        "Reviens une fois par semaine. Pas tous les jours.",
      ])),
    carte(h("h2", {}, "À quoi sert chaque onglet"),
      h("dl", {}, [
        ["Aujourd'hui", "L'état des données, le résumé du jour, tes ordres, et la probabilité de hausse de chaque actif."],
        ["Portefeuille", "Ton portefeuille réel (saisi à la main) et le portefeuille fictif automatique."],
        ["Marché", "Le contexte : régime de marché, corrélations entre actifs, risque de chacun."],
        ["Modèle", "Les preuves : fiabilité des probabilités, backtest, suivi en conditions réelles."],
        ["Actus", "Les événements marquants des dernières 36 heures, analysés automatiquement."],
      ].flatMap(([t, d]) => [h("dt", {}, t), h("dd", {}, d)]))),
    carte(h("h2", {}, "Ce que l'application ne fait pas"),
      liste("regles", [
        "Elle ne passe aucun ordre réel et ne se connecte à aucun compte.",
        "Elle ne tient pas compte de ta situation personnelle, de tes impôts ni de tes autres placements.",
        "Elle ne remplace pas un conseiller. En cas de doute sur une somme importante, demande l'avis d'un professionnel.",
      ])),
    carte(h("h2", {}, "Lexique"), h("dl", {}, lexique.flatMap(([t, d]) => [h("dt", {}, t), h("dd", {}, d)]))),
    carte(h("h2", {}, "Nouveautés"),
      liste("regles", [
        "Deux méthodes au choix dans l'onglet Portefeuille : Simple (un ETF Monde) ou Stratégie (les huit ETF du modèle).",
        "Suivi de ton portefeuille : valeur, gain ou perte, et courbe dans le temps.",
        "Fiche détaillée de chaque actif : cours sur un an, historique des probabilités, risque.",
        "Carte « Depuis hier » sur l'accueil : ce qui a changé depuis la dernière séance.",
      ])),
    carte(h("h2", {}, "Mises à jour"),
      h("p", {}, "Les données se mettent à jour toutes seules chaque nuit. La ligne colorée sous le titre indique si elles sont à jour (vert) ou non (rouge)."),
      h("p", { class: "discret" }, `Version de l'application : ${VERSION}`
        + (versionPubliee && versionPubliee !== VERSION && VERSION !== "dev" ? ` · version en ligne : ${versionPubliee}` : " · à jour")),
      h("button", { class: "secondaire", onclick: mettreAJourApplication }, "Forcer la mise à jour de l'application")),
    h("button", { class: "action", onclick: () => afficher("aujourdhui") }, "Retour à l'accueil"))];
}

// ---------- courbe en SVG ----------
function courbe(dates, series, logarithmique, format) {
  const lire0 = format || (x => nb(x, 0));
  const axe = format || (x => x >= 1000 ? Math.round(x / 100) / 10 + "k" : Math.round(x));
  const L = 340, H = 190, g = format ? 46 : 34, d = 8, ht = 8, b = 20;
  const ns = "http://www.w3.org/2000/svg";
  const f = logarithmique ? Math.log : x => x;
  const toutes = series.flatMap(s => s.valeurs).filter(v => v != null);
  let mini = Math.min(...toutes), maxi = Math.max(...toutes);
  if (mini === maxi) { mini *= 0.99; maxi *= 1.01; }
  const x = i => g + i / Math.max(1, dates.length - 1) * (L - g - d);
  const y = v => ht + (1 - (f(v) - f(mini)) / (f(maxi) - f(mini))) * (H - ht - b);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${L} ${H}`); svg.setAttribute("class", "courbe"); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", series.map(s => `${s.nom} : ${nb(s.valeurs[s.valeurs.length - 1], 0)}`).join(", "));
  const el = (nom, attributs) => { const e = document.createElementNS(ns, nom); for (const k in attributs) e.setAttribute(k, attributs[k]); svg.append(e); return e; };
  for (let k = 0; k <= 3; k++) {
    const v = logarithmique ? Math.exp(f(mini) + k / 3 * (f(maxi) - f(mini))) : mini + k / 3 * (maxi - mini);
    el("line", { x1: g, x2: L - d, y1: y(v), y2: y(v), stroke: "var(--trait)", "stroke-width": 1 });
    el("text", { x: g - 5, y: y(v) + 4, "text-anchor": "end" }).textContent = axe(v);
  }
  // Sur moins d'un an et demi, on affiche le jour et le mois ; au-delà, l'année suffit.
  const court = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 864e5 < 550;
  const repereDate = iso => court ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(2, 4) : iso.slice(0, 4);
  el("text", { x: g, y: H - 5 }).textContent = repereDate(dates[0]);
  el("text", { x: L - d, y: H - 5, "text-anchor": "end" }).textContent = repereDate(dates[dates.length - 1]);
  for (const s of series) {
    el("polyline", { fill: "none", stroke: `var(${s.couleur})`, "stroke-width": 2, "stroke-linejoin": "round",
      points: s.valeurs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ") });
  }
  const repere = el("line", { y1: ht, y2: H - b, stroke: "var(--texte-2)", "stroke-width": 1, visibility: "hidden" });
  const bulle = h("div", { class: "infobulle" }, "Touchez la courbe pour lire les valeurs.");
  const lire = evenement => {
    const zone = svg.getBoundingClientRect();
    const px = (evenement.clientX - zone.left) / zone.width * L;
    const i = Math.max(0, Math.min(dates.length - 1, Math.round((px - g) / (L - g - d) * (dates.length - 1))));
    repere.setAttribute("x1", x(i)); repere.setAttribute("x2", x(i)); repere.setAttribute("visibility", "visible");
    bulle.textContent = jour(dates[i]) + " · " + series.map(s => `${s.nom} ${lire0(s.valeurs[i])}`).join(" · ");
  };
  svg.addEventListener("pointermove", lire); svg.addEventListener("pointerdown", lire);
  const legende = h("div", { class: "legende" }, ...series.map(s =>
    h("span", {}, h("i", { style: `background:var(${s.couleur})` }), `${s.nom} : ${lire0(s.valeurs[s.valeurs.length - 1])}`)));
  return h("div", {}, legende, svg, bulle);
}

// ---------- navigation ----------
const VUES = { aujourdhui: vueAujourdhui, portefeuille: vuePortefeuilleEcran, marche: vueMarche, modele: vueModele, actus: vueActus, guide: vueGuide, actif: vueActif };
document.getElementById("bouton-guide").addEventListener("click", () => { if (D) { afficher("guide"); window.scrollTo(0, 0); } });
function afficher(nom) {
  onglet = nom;
  document.querySelectorAll(".onglets button").forEach(b => b.classList.toggle("actif", b.dataset.onglet === nom));
  contenu.replaceChildren(...VUES[nom]());
  if (nom === "guide" || nom === "actif") window.scrollTo(0, 0);
}
document.querySelectorAll(".onglets button").forEach(b => b.addEventListener("click", () => { afficher(b.dataset.onglet); window.scrollTo(0, 0); }));

// Indique en tête si les données sont à jour : la collecte tourne chaque nuit, donc au-delà de
// 36 heures sans nouvelle génération (72 h le week-end), quelque chose s'est arrêté.
function afficherEtatMaj() {
  const genere = new Date(D.genere_le), heures = (Date.now() - genere) / 36e5;
  const quand = genere.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const aJour = heures <= 36;
  const zone = document.getElementById("etat-maj");
  zone.className = "maj " + (aJour ? "ok" : "retard");
  zone.textContent = aJour ? `À jour · actualisé le ${quand}` : `Pas à jour · dernière actualisation le ${quand}`;
  document.getElementById("date-donnees").textContent = "Marchés jusqu'au " + jour(D.date_donnees);
  document.getElementById("pastille-regime").textContent = D.regime.actuel;
}

function charger() {
  return fetch("donnees.json", { cache: "no-store" }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(donnees => {
    D = donnees;
    afficherEtatMaj();
    afficher(onglet);
  });
}

// Recharge complète : vide la copie hors ligne puis relance l'application sur la dernière version.
async function mettreAJourApplication() {
  try {
    if (window.caches) for (const cle of await caches.keys()) await caches.delete(cle);
    if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch { /* on recharge quand même */ }
  location.reload();
}

fetch("version.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(v => {
  versionPubliee = v && v.version;
  if (D) afficher(onglet);
}).catch(() => {});

// Au retour dans l'application, on redemande les données si elles ont plus d'une heure.
let dernierChargement = Date.now();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - dernierChargement > 36e5) { dernierChargement = Date.now(); charger().catch(() => {}); }
});

charger().catch(() => {
  contenu.replaceChildren(carte(h("h2", {}, "Données indisponibles"),
    h("p", {}, "Impossible de charger les données du jour. Vérifie ta connexion, puis réessaie."),
    h("button", { class: "action", onclick: () => location.reload() }, "Réessayer")));
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
