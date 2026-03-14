import re
import json
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.cluster import KMeans
import umap

# === 設定 ===
INPUT_XLSX = "data/2025-data/syllabus-rev.xlsx"
OUTPUT_JSON = "network_data.json"
SIMILARITY_THRESHOLD = 0.55  # 埋め込みベースのためTF-IDFより高めに設定
N_TOPICS = 20  # トピッククラスタ数
UMAP_N_NEIGHBORS = 15
UMAP_MIN_DIST = 0.3

# === データ読み込み ===
print("Loading data...")
df = pd.read_excel(INPUT_XLSX)
print(f"  Total courses: {len(df)}")

# カラム名
col_code = "時間割コード／ClassCode"
col_name_ja = "開講科目名／Course Name (Japanese)"
col_name_en = "開講科目名(英)／Course Name"
col_instructor = "担当教員／Instructor"
col_subtitle = "授業サブタイトル／Course Subtitle"
col_objective = "授業の目的と概要／Course Objective"
col_goals = "学習目標／Learning Goals"
col_semester = "開講区分(開講学期)／Semester"
col_day = "曜日・時間／Day and Period"
col_room = "教室／Room"

# 欠損値処理
for col in [col_subtitle, col_objective, col_goals, col_instructor]:
    df[col] = df[col].fillna("")

# === テキスト結合（サブタイトル + 目的と概要 + 学習目標）===
print("Preparing text for embedding...")
texts = []
for _, row in df.iterrows():
    parts = []
    if row[col_subtitle]:
        parts.append(str(row[col_subtitle]))
    if row[col_objective]:
        parts.append(str(row[col_objective]))
    if row[col_goals]:
        parts.append(str(row[col_goals]))
    combined = " ".join(parts)
    texts.append(combined if combined.strip() else "（内容なし）")

# === Sentence-Transformers による高次元埋め込み ===
print("Computing sentence embeddings (multilingual model)...")
model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
embeddings = model.encode(texts, show_progress_bar=True, batch_size=64)
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

# 座標をスケーリング（ネットワーク表示用）
coords_2d -= coords_2d.mean(axis=0)
scale = 600 / max(coords_2d.max() - coords_2d.min(), 1)
coords_2d *= scale

# === トピッククラスタリング ===
print(f"Clustering into {N_TOPICS} topic clusters...")
kmeans = KMeans(n_clusters=N_TOPICS, random_state=42, n_init=10)
cluster_labels = kmeans.fit_predict(embeddings)

# クラスタごとの代表的なテキストを表示（確認用）
print("\n=== Topic Clusters ===")
for c in range(N_TOPICS):
    indices = np.where(cluster_labels == c)[0]
    sample_titles = [str(df.iloc[i][col_name_ja])[:40] for i in indices[:3]]
    print(f"  Cluster {c} ({len(indices)} courses): {', '.join(sample_titles)}")

# === ノード作成 ===
print("\nBuilding nodes...")
nodes = []
for i, row in df.iterrows():
    instructors = re.split(r"[、,]", str(row[col_instructor]))
    instructors = [s.strip() for s in instructors if s.strip()]

    nodes.append({
        "id": str(row[col_code]),
        "label": str(row[col_name_ja]),
        "label_en": str(row[col_name_en]) if pd.notna(row[col_name_en]) else "",
        "subtitle": str(row[col_subtitle]) if row[col_subtitle] else "",
        "instructors": instructors,
        "objective": str(row[col_objective])[:800] if row[col_objective] else "",
        "goals": str(row[col_goals])[:500] if row[col_goals] else "",
        "semester": str(row[col_semester]) if pd.notna(row[col_semester]) else "",
        "day_period": str(row[col_day]) if pd.notna(row[col_day]) else "",
        "room": str(row[col_room]) if pd.notna(row[col_room]) else "",
        "cluster": int(cluster_labels[i]),
        "x": float(coords_2d[i, 0]),
        "y": float(coords_2d[i, 1]),
    })

# === エッジ作成 ===
print("Building edges...")
edges = []
n = len(df)
for i in range(n):
    for j in range(i + 1, n):
        weight = float(sim_matrix[i, j])
        if weight >= SIMILARITY_THRESHOLD:
            edges.append({
                "source": str(df.iloc[i][col_code]),
                "target": str(df.iloc[j][col_code]),
                "weight": round(weight, 4),
            })

print(f"  Edges (threshold={SIMILARITY_THRESHOLD}): {len(edges)}")

# エッジが多すぎる場合は閾値を上げる
if len(edges) > 50000:
    print("  Too many edges, raising threshold...")
    new_threshold = SIMILARITY_THRESHOLD
    while len(edges) > 30000:
        new_threshold += 0.05
        edges = [e for e in edges if e["weight"] >= new_threshold]
    print(f"  Adjusted threshold: {new_threshold}, edges: {len(edges)}")

# === JSON出力 ===
network_data = {"nodes": nodes, "edges": edges}
with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
    json.dump(network_data, f, ensure_ascii=False, indent=2)

print(f"\nDone! Nodes: {len(nodes)}, Edges: {len(edges)}")
print(f"Output: {OUTPUT_JSON}")
