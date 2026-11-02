-- ============================================================
-- PORTEFEUILLE VIRTUEL DE DOCUMENTS - Schéma Supabase (Postgres)
-- Pas d'utilisation de Supabase Auth : gestion maison des users.
-- Les fichiers scannés sont stockés dans Supabase Storage
-- (bucket privé "documents"), cette table ne garde que le chemin.
-- ============================================================

-- ------------------------------------------------------------
-- Table USERS
-- ------------------------------------------------------------
create table users (
    id bigint generated always as identity primary key,
    username varchar(50) not null unique,
    email varchar(255) not null unique,
    password_hash text not null,
    full_name varchar(150),
    created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Table DOCUMENTS
-- Chaque ligne = un scan (une version) d'un document.
-- On garde l'historique ; le backend prend le plus récent par
-- (user_id, document_type) comme version "active".
-- ------------------------------------------------------------
create table documents (
    id bigint generated always as identity primary key,
    user_id bigint not null references users(id) on delete cascade,

    document_type text not null check (
        document_type in ('cni', 'carte_grise', 'permis_conduire', 'passeport')
    ),

    -- Chemin dans le bucket Supabase Storage (pas l'URL publique)
    storage_path text not null,
    original_filename text,
    mime_type text,

    -- Métadonnées optionnelles extraites/saisies du document
    document_number text,
    issue_date date,
    expiry_date date,

    uploaded_at timestamptz not null default now()
);

create index idx_documents_user_id on documents (user_id);
create index idx_documents_user_type on documents (user_id, document_type, uploaded_at desc);

-- ------------------------------------------------------------
-- RLS activé, sans policies : seul le backend (clé service_role)
-- peut lire/écrire, car service_role bypass RLS par défaut.
-- Le frontend ne doit JAMAIS recevoir cette clé.
-- ------------------------------------------------------------
alter table users enable row level security;
alter table documents enable row level security;

-- ------------------------------------------------------------
-- Bucket de stockage à créer (dashboard Supabase > Storage) :
--   nom       : documents
--   visibilité: privé (Private bucket)
-- Chemin conseillé pour chaque fichier :
--   {user_id}/{document_type}/{timestamp}_{original_filename}
-- ------------------------------------------------------------
