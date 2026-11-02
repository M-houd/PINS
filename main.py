"""
Portefeuille virtuel de documents (CNI, carte grise, permis, passeport)
Backend Flask - port 5000

Base de données : Supabase Postgres (tables users, documents)
Stockage fichiers : Supabase Storage (bucket privé "documents")
Pas de Supabase Auth : gestion maison des utilisateurs.

Toutes les routes /api/documents/* nécessitent un user_id valide
(envoyé par le frontend après login). Pour un vrai projet en
production, remplacer ce user_id "en clair" par un token de session
signé (JWT maison ou cookie de session côté serveur).
"""

import os
import uuid
from datetime import datetime

from flask import Flask, request, jsonify
from flask_cors import CORS
from supabase import create_client, Client
from dotenv import load_dotenv
import bcrypt

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
STORAGE_BUCKET = os.environ.get("STORAGE_BUCKET", "documents")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définis "
        "dans un fichier .env (voir .env.example)."
    )

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

app = Flask(__name__)
CORS(app)  # à restreindre au domaine du frontend en production

ALLOWED_DOCUMENT_TYPES = {"cni", "carte_grise", "permis_conduire", "passeport"}
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "application/pdf"}
MAX_FILE_SIZE_MB = 10


# ------------------------------------------------------------------
# Helpers - Auth maison
# ------------------------------------------------------------------
def hash_password(plain_password: str) -> str:
    return bcrypt.hashpw(plain_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def check_password(plain_password: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed.encode("utf-8"))


def public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "email": user["email"],
        "full_name": user.get("full_name"),
    }


# ------------------------------------------------------------------
# Routes - Utilisateurs
# ------------------------------------------------------------------
@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    full_name = (data.get("full_name") or "").strip()

    if not username or not email or not password:
        return jsonify({"error": "username, email et password sont requis"}), 400
    if len(password) < 6:
        return jsonify({"error": "Le mot de passe doit faire au moins 6 caractères"}), 400

    existing = (
        supabase.table("users")
        .select("id")
        .or_(f"username.eq.{username},email.eq.{email}")
        .execute()
    )
    if existing.data:
        return jsonify({"error": "Nom d'utilisateur ou email déjà utilisé"}), 409

    result = supabase.table("users").insert({
        "username": username,
        "email": email,
        "password_hash": hash_password(password),
        "full_name": full_name or None,
    }).execute()

    return jsonify(public_user(result.data[0])), 201


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    identifier = (data.get("username") or data.get("email") or "").strip()
    password = data.get("password") or ""

    if not identifier or not password:
        return jsonify({"error": "username/email et password sont requis"}), 400

    result = (
        supabase.table("users")
        .select("*")
        .or_(f"username.eq.{identifier},email.eq.{identifier.lower()}")
        .execute()
    )
    if not result.data:
        return jsonify({"error": "Identifiants invalides"}), 401

    user = result.data[0]
    if not check_password(password, user["password_hash"]):
        return jsonify({"error": "Identifiants invalides"}), 401

    return jsonify(public_user(user)), 200


# ------------------------------------------------------------------
# Routes - Documents
# ------------------------------------------------------------------
@app.route("/api/documents", methods=["GET"])
def list_documents():
    """Retourne, pour l'utilisateur donné, le document le plus récent
    de chaque type, avec une URL signée temporaire pour l'affichage."""
    user_id = request.args.get("user_id", type=int)
    if not user_id:
        return jsonify({"error": "user_id est requis"}), 400

    result = (
        supabase.table("documents")
        .select("*")
        .eq("user_id", user_id)
        .order("uploaded_at", desc=True)
        .execute()
    )

    # Ne garder que le plus récent par type de document
    latest_by_type = {}
    for doc in result.data:
        if doc["document_type"] not in latest_by_type:
            latest_by_type[doc["document_type"]] = doc

    documents = []
    for doc in latest_by_type.values():
        signed = supabase.storage.from_(STORAGE_BUCKET).create_signed_url(
            doc["storage_path"], 300  # URL valable 5 minutes
        )
        documents.append({
            "id": doc["id"],
            "document_type": doc["document_type"],
            "document_number": doc.get("document_number"),
            "issue_date": doc.get("issue_date"),
            "expiry_date": doc.get("expiry_date"),
            "uploaded_at": doc["uploaded_at"],
            "mime_type": doc.get("mime_type"),
            "signed_url": signed.get("signedURL") or signed.get("signed_url"),
        })

    return jsonify(documents), 200


@app.route("/api/documents", methods=["POST"])
def upload_document():
    """
    Upload multipart/form-data attendu :
      - file            : le fichier scanné (image ou PDF)
      - user_id         : id de l'utilisateur
      - document_type   : cni | carte_grise | permis_conduire | passeport
      - document_number : optionnel
      - issue_date      : optionnel (YYYY-MM-DD)
      - expiry_date     : optionnel (YYYY-MM-DD)
    """
    user_id = request.form.get("user_id", type=int)
    document_type = request.form.get("document_type", "")
    document_number = request.form.get("document_number") or None
    issue_date = request.form.get("issue_date") or None
    expiry_date = request.form.get("expiry_date") or None
    file = request.files.get("file")

    if not user_id or not document_type or not file:
        return jsonify({"error": "user_id, document_type et file sont requis"}), 400

    if document_type not in ALLOWED_DOCUMENT_TYPES:
        return jsonify({"error": f"document_type invalide (attendu: {sorted(ALLOWED_DOCUMENT_TYPES)})"}), 400

    if file.mimetype not in ALLOWED_MIME_TYPES:
        return jsonify({"error": "Format de fichier non autorisé (image ou PDF uniquement)"}), 400

    file_bytes = file.read()
    if len(file_bytes) > MAX_FILE_SIZE_MB * 1024 * 1024:
        return jsonify({"error": f"Fichier trop volumineux (max {MAX_FILE_SIZE_MB} Mo)"}), 400

    # Vérifie que l'utilisateur existe
    user_check = supabase.table("users").select("id").eq("id", user_id).execute()
    if not user_check.data:
        return jsonify({"error": "Utilisateur introuvable"}), 404

    # Construit un chemin unique dans le bucket
    ext = os.path.splitext(file.filename or "")[1] or ""
    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    unique_id = uuid.uuid4().hex[:8]
    storage_path = f"{user_id}/{document_type}/{timestamp}_{unique_id}{ext}"

    supabase.storage.from_(STORAGE_BUCKET).upload(
        storage_path,
        file_bytes,
        {"content-type": file.mimetype},
    )

    result = supabase.table("documents").insert({
        "user_id": user_id,
        "document_type": document_type,
        "storage_path": storage_path,
        "original_filename": file.filename,
        "mime_type": file.mimetype,
        "document_number": document_number,
        "issue_date": issue_date,
        "expiry_date": expiry_date,
    }).execute()

    doc = result.data[0]
    signed = supabase.storage.from_(STORAGE_BUCKET).create_signed_url(storage_path, 300)

    return jsonify({
        "id": doc["id"],
        "document_type": doc["document_type"],
        "uploaded_at": doc["uploaded_at"],
        "signed_url": signed.get("signedURL") or signed.get("signed_url"),
    }), 201


@app.route("/api/documents/<int:document_id>", methods=["DELETE"])
def delete_document(document_id):
    user_id = request.args.get("user_id", type=int)
    if not user_id:
        return jsonify({"error": "user_id est requis"}), 400

    doc_result = (
        supabase.table("documents")
        .select("*")
        .eq("id", document_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not doc_result.data:
        return jsonify({"error": "Document introuvable"}), 404

    doc = doc_result.data[0]
    supabase.storage.from_(STORAGE_BUCKET).remove([doc["storage_path"]])
    supabase.table("documents").delete().eq("id", document_id).execute()

    return jsonify({"status": "deleted"}), 200


# ------------------------------------------------------------------
# Santé
# ------------------------------------------------------------------
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


# ------------------------------------------------------------------
# Entrée principale
# ------------------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
