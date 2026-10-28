# Live Model Map

Carte interactive des modèles d'IA open source : leur lignée, leur prix, leur volume d'usage et
leur état (en ligne, dégradé, en panne, faille de sécurité). Un robot GitHub fait un check-up
toutes les ~10 minutes et republie le site, gratuitement, sans serveur.

## Comment ça marche

```
GitHub Actions (toutes les ~10 min)
  └─ pipeline/checkup.py
       ├─ relit l'état précédent depuis le site publié (data/*.json)
       ├─ Hugging Face : modèles tendance, lignée (base_model), contexte, téléchargements
       ├─ OpenRouter   : prix + disponibilité de chaque modèle servi
       ├─ pipeline/status_overrides.json : failles signalées à la main
       └─ écrit models.json, events.json, checkups.json, todo.json
  └─ construit le site (frontend/) et le publie sur GitHub Pages

Le site relit data/*.json chaque minute et anime ce qui a changé.
```

```
live-model-map/
├── .github/workflows/checkup.yml   le robot (planning, check-up, publication)
├── pipeline/
│   ├── checkup.py                  une passe de check-up
│   └── status_overrides.json       failles / états signalés à la main
├── sources/
│   ├── hf_collector.py             source Hugging Face
│   └── openrouter_source.py        source OpenRouter (prix, disponibilité)
└── frontend/                       site React + réseau 3D (statique)
```

## Le site

### Réseau 3D

`frontend/src/network3d/` — react-force-graph-3d + Three.js, chargé à part (lazy) :

- **Noyau central « Live Analysis Core »** : le check-up qui collecte et analyse les données.
- **Fournisseurs** autour du noyau : sphères de verre avec le logo Hugging Face de
  l'organisation à l'intérieur (initiales si elle n'en a pas). Halo = pire état de ses modèles.
- **Modèles** en satellites de leur fournisseur, colorés selon leur état ; liens violets =
  vraie lignée (`base_model`).
- **Volume** : rayon ∝ racine cubique des téléchargements/jour (le volume de la sphère est donc
  proportionnel au volume réel), avec un minimum et un maximum, et un changement de taille animé.
- **Flux** : des particules vont de chaque fournisseur vers le noyau ; leur nombre (1 à 4)
  suit le volume de téléchargements, leur couleur l'état. Aucun trafic entre modèles n'est inventé.
- Physique douce (forces, anti-collision, noyau fixe), flottement léger, glisser-déposer,
  rotation / zoom / déplacement, survol (infobulle), clic (panneau + caméra qui s'approche),
  bouton « Recentrer la vue ».
- Performances : géométries, matériaux et textures partagés et libérés au démontage, une seule
  boucle d'animation, densité de pixels plafonnée, rendu en pause quand l'onglet est caché.
  Avec « réduire les animations » (système), plus de flottement, de pulsation ni de particules.
- Sans WebGL, un message l'explique ; les listes et le panneau de détails restent utilisables.

### États (couleur des nœuds)

| État | Couleur | Origine |
|---|---|---|
| Fonctionne | vert | meilleur fournisseur OpenRouter ≥ 95 % de disponibilité sur 30 min |
| Dégradé | orange | entre 0 et 95 % |
| En panne | rouge, pointillés | 0 %, ou plus aucun fournisseur |
| Faille de sécurité | violet, pulsation | automatique (analyse Hugging Face) ou signalée à la main |
| État inconnu | gris | modèle absent d'OpenRouter |

### Barre latérale et panneau

- **À traiter** : failles, pannes, modèles dégradés et nouveaux modèles (3 jours). Les cases
  « vu » sont mémorisées dans ton navigateur.
- **Fil** : chaque nouveau modèle et chaque changement d'état ou de prix.
- **Check-ups** : l'historique des passes du robot (durée, nouveautés, erreurs).
- Clic sur un nœud : détails et comparaison avec son parent ou n'importe quel autre modèle.

## Détection automatique des failles

Hugging Face analyse les fichiers de chaque dépôt de modèle (logiciels malveillants, fichiers
pickle capables d'exécuter du code). Le check-up lit ce résultat pour chaque nouveau modèle et
pour tous les modèles toutes les ~6 h. Un fichier classé `unsafe` ou `suspicious` fait passer
le modèle en **Faille de sécurité**, avec les fichiers en cause ; l'alerte disparaît d'elle-même
quand Hugging Face ne signale plus rien. Le niveau `caution` (souvent un simple script Python)
est ignoré.

Ce que cette détection ne voit pas : les failles du modèle lui-même (jailbreak, fuite de
données d'entraînement) ou des fournisseurs qui le servent. Celles-là se signalent à la main.

## Signaler une faille à la main (par ex. après une analyse REA)

Sur GitHub, ouvre `pipeline/status_overrides.json`, clique sur le crayon, et ajoute le modèle :

```json
{
  "models": {
    "org/modele": { "status": "security_incident", "detail": "Ce qui a été trouvé" }
  }
}
```

Valide (« Commit changes ») : le robot repart aussitôt et la carte se met à jour en quelques
minutes. Pour retirer l'alerte, supprime la ligne. Une faille signalée ainsi n'est jamais
effacée par le robot, et elle prime sur la détection automatique.

## Limites à connaître

- **Rythme** : GitHub lance les tâches planifiées avec parfois quelques minutes de retard.
- **Pause après 60 jours** : sur un dépôt public, GitHub suspend les tâches planifiées après
  60 jours sans activité sur le dépôt. Il prévient par e-mail ; il suffit de cliquer sur
  « Enable workflow » dans l'onglet Actions. Le site affiche un bandeau si le dernier check-up
  date de plus de 40 minutes.
- **Quota Hugging Face** : sans compte, Hugging Face limite le nombre de requêtes. Le robot
  s'arrête proprement et reprend à la passe suivante. Pour un quota plus large, crée un jeton
  gratuit sur huggingface.co (Settings → Access Tokens, type « Read ») et ajoute-le dans le
  dépôt : Settings → Secrets and variables → Actions → New repository secret, nom `HF_TOKEN`.
- **Données absentes** : ni Hugging Face ni OpenRouter ne publient vitesse, latence, ELO,
  nombre de requêtes, tokens traités, taux d'erreur ou nombre d'utilisateurs en direct. Le
  panneau d'un modèle n'affiche que les mesures disponibles, et le volume des nœuds repose sur
  les téléchargements (moyenne sur 30 jours), pas sur un trafic en temps réel.
- **Logos** : ce sont les avatars que chaque organisation a choisis sur Hugging Face ; ils
  restent la propriété de leurs auteurs.

## Lancer en local

```bash
python3 pipeline/checkup.py                 # écrit frontend/public/data/
cd frontend && npm install && npm run dev   # http://localhost:5173
```

Node est installé dans `~/.local/node` sur ce Mac :
`export PATH="$HOME/.local/node/bin:$PATH"`.
