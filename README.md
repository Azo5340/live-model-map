# Live Model Map

Carte interactive de la lignée des modèles d'IA, mise à jour en direct par WebSocket.

```
live-model-map/
├── backend/                 FastAPI
│   └── app/
│       ├── main.py          routes REST + /ws/stream + ingestion
│       ├── schemas.py       AIModel, REAEvent, StreamEvent… (Pydantic)
│       ├── store.py         registre en mémoire, persisté dans data/models.json
│       ├── stream.py        diffusion WebSocket à tous les clients
│       └── compare.py       calcul des deltas ("+20% plus rapide")
├── frontend/                React + Vite + Tailwind v4 + React Flow
│   └── src/
│       ├── App.tsx          carte, layout dagre, gestion des événements live
│       ├── components/      ModelNode, SidePanel (comparaison + graphiques), EventFeed
│       └── useStream.ts     client WebSocket avec reconnexion
├── rea_client/
│   ├── push_to_live_map.py  fonction d'envoi à appeler depuis n'importe quel collecteur
│   └── simulate.py          données fictives pour tester les animations
└── docker-compose.yml
```

## Lancer

### Sans Docker

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8000
```

```bash
cd frontend && npm install && npm run dev      # http://localhost:5173
```

Node est installé dans `~/.local/node` (Homebrew ne fournit pas de binaire pour ce Mac Intel).
Pour que `node`/`npm` soient trouvés dans un nouveau terminal :

```bash
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zshrc
```

```bash
cd rea_client && python3 simulate.py           # données de démo en continu
```

### Avec Docker

```bash
docker compose up --build
```

## API

| Méthode | Route | Rôle |
|---|---|---|
| GET  | `/api/models` | `{nodes: AIModel[], links: {source, target}[]}` |
| GET  | `/api/models/{id}/compare/{target_id}` | deltas par métrique |
| GET  | `/api/events?limit=50` | derniers événements (pour remplir le fil au chargement) |
| POST | `/api/ingest/rea-event` | ingestion depuis le collecteur |
| POST | `/api/models/{id}/status` | changement d'état manuel (seul moyen de poser/retirer une faille) |
| WS   | `/ws/stream` | `MODEL_ADDED`, `METRICS_UPDATED`, `STATUS_CHANGED`, `ALERT` |

Corps attendu par `/api/ingest/rea-event` :

```json
{
  "source": "rea",
  "detected_at": "2026-10-28T12:00:00Z",
  "models": [{
    "id": "provider/model-name", "name": "Model Name", "provider": "Provider",
    "parent_model_id": null, "release_date": "2026-10-01T00:00:00Z",
    "metrics": {"tokens_per_sec": 0, "latency_ms": 0, "cost_per_1k_tokens": 0, "context_window": 0, "elo_score": 0},
    "usage_stats": {"download_count_24h": 0, "active_requests_est": 0}
  }],
  "alerts": [{"message": "…", "level": "info", "model_id": "provider/model-name"}]
}
```

`usage` et `usage_stats` sont tous deux acceptés. Un modèle identique à la version stockée
ne déclenche aucun événement. Si `INGEST_TOKEN` est défini côté backend, le collecteur doit
envoyer l'en-tête `X-Ingest-Token` (variable `LIVE_MAP_INGEST_TOKEN` pour `push_to_live_map.py`).

## Collecteur Hugging Face

```bash
cd rea_client && python3 hf_collector.py          # une passe par heure, jusqu'à Ctrl+C
python3 hf_collector.py --once --limit 50 --sort downloads
```

À chaque passe : liste les modèles `text-generation` les plus tendance, remonte leur lignée
(`cardData.base_model` → `parent_model_id`, sur 2 générations), lit la taille du contexte dans
leur `config.json`, puis n'envoie que les modèles nouveaux ou modifiés.
Le prix vient du catalogue public d'OpenRouter, rapproché via le `hugging_face_id` qu'il indique
pour les modèles open source : `cost_per_1k_tokens` est un prix mixte (3 tokens d'entrée pour 1 de
sortie, en $ pour 1 000 tokens), le tarif payant étant préféré aux variantes `:free`. OpenRouter
fournit aussi le contexte servi, utilisé quand le `config.json` n'en donne pas.

- `--openrouter-catalog` ajoute en plus tous les modèles open source servis sur OpenRouter
  (~170, environ 2 min par passe) : c'est ce qui donne une carte avec des prix pour la plupart des nœuds.
- `--no-openrouter` désactive cette source.

Ni l'une ni l'autre source ne fournit vitesse, latence ou ELO : ces champs restent vides.
`download_count_24h` est une estimation (téléchargements des 30 derniers jours / 30).
`HF_TOKEN` (optionnel) augmente les limites de requêtes Hugging Face.

## Lire la carte

- **Taille d'un nœud** = volume d'usage, sur une échelle logarithmique : requêtes actives si une
  source les fournit, sinon téléchargements par jour (moyenne Hugging Face sur 30 jours).
- **Couleur d'un nœud** = son état :

| État | Couleur | Origine |
|---|---|---|
| `operational` | vert | meilleur fournisseur OpenRouter ≥ 95 % de disponibilité sur 5 min |
| `degraded` | orange | entre 0 et 95 % |
| `down` | rouge, pointillés | 0 %, ou plus aucun fournisseur |
| `security_incident` | violet, pulsation | signalé à la main uniquement |
| `unknown` | gris | modèle absent d'OpenRouter, pas de source d'état |

Chaque changement d'état produit un événement `STATUS_CHANGED`, affiché dans le fil.

### Signaler un état à la main (ex. faille trouvée avec REA)

```bash
cd rea_client
python3 report_status.py org/model security_incident "Ce qui a été trouvé" --source rea
python3 report_status.py org/model operational      # retire l'incident
```

Une faille de sécurité reste affichée tant qu'elle n'est pas retirée ainsi : les collecteurs ne
peuvent pas l'écraser. Équivalent HTTP : `POST /api/models/{id}/status` avec
`{"status": "...", "detail": "...", "source": "..."}`.

Attention : `POST /api/ingest/rea-event` remplace le modèle entier. Un envoi partiel efface
les métriques absentes ; envoie toujours la fiche complète (le collecteur le fait).

## Brancher un collecteur

```python
from push_to_live_map import push_to_live_map

models = collect()            # ta logique d'extraction → liste de dicts
push_to_live_map(models)      # n'envoie que les modèles nouveaux ou modifiés
```

Si les noms de champs de ta source diffèrent, adapte `format_model()` dans
`rea_client/push_to_live_map.py`. Depuis le shell : `my_collector | python push_to_live_map.py -`.
