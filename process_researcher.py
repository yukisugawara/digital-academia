import re
import json
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.cluster import KMeans
import umap

# === 設定 ===
ACHIEVEMENT_XLSX = "data/2025-data/researchmap/achievement.xlsx"
RESEARCHER_XLSX = "data/2025-data/researcher-rev.xlsx"
OUTPUT_JSON = "researcher_network_data.json"
SIMILARITY_THRESHOLD = 0.45
N_TOPICS = 15
UMAP_N_NEIGHBORS = 15
UMAP_MIN_DIST = 0.3

# === データ読み込み ===
print("Loading data...")
ach_df = pd.read_excel(ACHIEVEMENT_XLSX)
res_df = pd.read_excel(RESEARCHER_XLSX)
print(f"  Achievements: {len(ach_df)}, Researchers: {len(res_df)}")

# sid でマッピング
col_title_ja = "タイトル(日本語)"
col_author_ja = "著者(日本語)"
col_sid = "sid"

# 研究者情報の準備
res_df = res_df.dropna(subset=[col_sid])
res_df = res_df.drop_duplicates(subset=[col_sid])
print(f"  Unique researchers with sid: {len(res_df)}")

# 各研究者の業績タイトルを結合
print("Aggregating achievement titles per researcher...")
ach_df[col_title_ja] = ach_df[col_title_ja].fillna("")

# sid ごとにタイトルを集約
titles_by_sid = {}
counts_by_sid = {}
for _, row in ach_df.iterrows():
    sid = row[col_sid]
    title = str(row[col_title_ja]).strip()
    if not title or title == "nan":
        continue
    if sid not in titles_by_sid:
        titles_by_sid[sid] = []
        counts_by_sid[sid] = 0
    titles_by_sid[sid].append(title)
    counts_by_sid[sid] += 1

# 業績があるresearcherのみに絞る
valid_sids = set(titles_by_sid.keys()) & set(res_df[col_sid].values)
res_df = res_df[res_df[col_sid].isin(valid_sids)].reset_index(drop=True)
print(f"  Researchers with achievements: {len(res_df)}")

# 各研究者のテキスト（全業績タイトルを結合）
texts = []
for _, row in res_df.iterrows():
    sid = row[col_sid]
    combined = " ".join(titles_by_sid.get(sid, []))
    texts.append(combined if combined.strip() else "（業績なし）")

# === Sentence-Transformers による高次元埋め込み ===
print("Computing sentence embeddings...")
model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
embeddings = model.encode(texts, show_progress_bar=True, batch_size=32)
print(f"  Embedding shape: {embeddings.shape}")

# === コサイン類似度計算 ===
print("Computing cosine similarity matrix...")
sim_matrix = cosine_similarity(embeddings)

# === UMAP次元削減（2Dレイアウト用）===
print("Running UMAP for 2D layout...")
reducer = umap.UMAP(
    n_components=2,
    n_neighbors=UMAP_N_NEIGHBORS,
    min_dist=UMAP_MIN_DIST,
    metric="cosine",
    random_state=42,
)
coords_2d = reducer.fit_transform(embeddings)

coords_2d -= coords_2d.mean(axis=0)
scale = 600 / max(coords_2d.max() - coords_2d.min(), 1)
coords_2d *= scale

# === トピッククラスタリング ===
print(f"Clustering into {N_TOPICS} topic clusters...")
kmeans = KMeans(n_clusters=N_TOPICS, random_state=42, n_init=10)
cluster_labels = kmeans.fit_predict(embeddings)

print("\n=== Topic Clusters ===")
for c in range(N_TOPICS):
    indices = np.where(cluster_labels == c)[0]
    sample_names = [str(res_df.iloc[i]["氏名"])[:20] for i in indices[:4]]
    print(f"  Cluster {c} ({len(indices)} researchers): {', '.join(sample_names)}")

# === ノード作成 ===
print("\nBuilding nodes...")
nodes = []
for i, row in res_df.iterrows():
    sid = row[col_sid]
    name_ja = str(row["氏名"]) if pd.notna(row["氏名"]) else ""
    name_en = str(row.get("name-en", "")) if pd.notna(row.get("name-en", None)) else ""
    affiliation = str(row.get("所属(LV2)", "")) if pd.notna(row.get("所属(LV2)", None)) else ""
    rank = str(row.get("職名", "")) if pd.notna(row.get("職名", None)) else ""

    # 代表的な業績タイトル（上位5件）
    top_titles = titles_by_sid.get(sid, [])[:5]

    nodes.append({
        "id": str(sid),
        "label": name_ja,
        "label_en": name_en,
        "affiliation": affiliation,
        "rank": rank,
        "achievement_count": counts_by_sid.get(sid, 0),
        "top_titles": top_titles,
        "cluster": int(cluster_labels[i]),
        "x": float(coords_2d[i, 0]),
        "y": float(coords_2d[i, 1]),
    })

# === エッジ作成 ===
print("Building edges...")
edges = []
n = len(res_df)
for i in range(n):
    for j in range(i + 1, n):
        weight = float(sim_matrix[i, j])
        if weight >= SIMILARITY_THRESHOLD:
            edges.append({
                "source": str(res_df.iloc[i][col_sid]),
                "target": str(res_df.iloc[j][col_sid]),
                "weight": round(weight, 4),
            })

print(f"  Edges (threshold={SIMILARITY_THRESHOLD}): {len(edges)}")

# エッジが多すぎる場合は閾値を上げる
if len(edges) > 10000:
    print("  Too many edges, raising threshold...")
    new_threshold = SIMILARITY_THRESHOLD
    while len(edges) > 5000:
        new_threshold += 0.05
        edges = [e for e in edges if e["weight"] >= new_threshold]
    print(f"  Adjusted threshold: {new_threshold}, edges: {len(edges)}")

# === JSON出力 ===
network_data = {"nodes": nodes, "edges": edges}
with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
    json.dump(network_data, f, ensure_ascii=False, indent=2)

print(f"\nDone! Nodes: {len(nodes)}, Edges: {len(edges)}")
print(f"Output: {OUTPUT_JSON}")
