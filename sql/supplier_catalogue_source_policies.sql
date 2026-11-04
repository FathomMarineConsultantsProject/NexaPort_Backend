-- Source-level approvals. Apply only to this exact supplier/source/document hash.
-- Installing this table grants no approval and creates no relationships.
CREATE TABLE IF NOT EXISTS public.supplier_catalogue_source_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nexaport_company_id text,
  verified_supplier_id uuid REFERENCES public.catalog_suppliers(id),
  external_source_name text NOT NULL,
  external_source_id text NOT NULL,
  source_url text NOT NULL,
  document_sha256 char(64) NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  supplier_identity_status text NOT NULL DEFAULT 'unresolved'
    CHECK (supplier_identity_status IN ('unresolved','verified')),
  supplier_identity_evidence text,
  offering_confirmation_status text NOT NULL DEFAULT 'missing'
    CHECK (offering_confirmation_status IN ('missing','reported_unverified','documented')),
  offering_scope text NOT NULL DEFAULT 'unknown'
    CHECK (offering_scope IN ('unknown','all_catalogue_rows','specified_rows')),
  offering_evidence text,
  internal_authorization_status text NOT NULL DEFAULT 'missing'
    CHECK (internal_authorization_status IN ('missing','reported','documented')),
  internal_authorization_evidence text,
  publication_rights_status text NOT NULL DEFAULT 'missing'
    CHECK (publication_rights_status IN ('missing','documented')),
  publication_rights_evidence text,
  publication_rights_scope text,
  approved_host text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_source_name,external_source_id,source_url,document_sha256)
);
ALTER TABLE public.supplier_catalogue_source_policies
  ADD COLUMN IF NOT EXISTS verified_supplier_id uuid REFERENCES public.catalog_suppliers(id);
CREATE INDEX IF NOT EXISTS supplier_catalogue_source_policies_company_idx
ON public.supplier_catalogue_source_policies(nexaport_company_id);
