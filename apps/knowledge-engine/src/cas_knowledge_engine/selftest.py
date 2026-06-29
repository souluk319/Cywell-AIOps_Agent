from __future__ import annotations

import base64
import io
import tempfile
import zipfile

from .engine import KnowledgeEngine


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"[PASS] {message}")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        engine = KnowledgeEngine(tmp)
        health = engine.health()
        expect(health["status"] == "ok", "health reports ok")
        upload = engine.ingest_upload(
            {
                "customer_id": "acme",
                "file_name": "openshift-runbook.txt",
                "filename": "openshift-runbook.txt",
                "content": "OpenShift router latency increased after ingress certificate rotation. Check route shards and HAProxy logs.",
                "source_scope": "user_upload",
                "visibility": "private_user",
                "index": True,
                "force_reingest": False,
            }
        )
        expect(upload["status"] == "indexed", "upload ingest indexes document")
        expect(upload["chunks_indexed"] >= 1, "upload ingest creates chunks")
        expect(upload["document"]["owner_id"] == "cas-local", "upload records default owner scope")
        expect(upload["document"]["metadata"]["pbs_payload"]["file_name"] == "openshift-runbook.txt", "upload records PBS file_name contract")
        expect(upload["document"]["metadata"]["pbs_payload"]["index"] is True, "upload records PBS index contract")
        encoded = base64.b64encode("Encoded upload keeps PBS-style base64 payloads ingestible.".encode("utf-8")).decode("ascii")
        base64_upload = engine.ingest_upload(
            {
                "customer_id": "acme",
                "filename": "encoded-runbook.txt",
                "content_base64": encoded,
                "mime_type": "text/plain",
            }
        )
        expect(base64_upload["status"] == "indexed", "base64 upload ingest indexes document")
        expect(base64_upload["document"]["metadata"]["parser"] == "binary-text", "base64 upload records parser metadata")
        expect(
            base64_upload["document"]["metadata"]["pbs_payload"]["content_fields"] == ["content_base64"],
            "base64 upload records PBS content field contract",
        )
        docx_buffer = io.BytesIO()
        with zipfile.ZipFile(docx_buffer, "w") as archive:
            archive.writestr(
                "word/document.xml",
                "<w:document><w:body><w:p><w:r><w:t>DOCX upload parser extracts OpenShift certificate renewal notes.</w:t></w:r></w:p></w:body></w:document>",
            )
        docx_upload = engine.ingest_upload(
            {
                "customer_id": "acme",
                "filename": "certificate-renewal.docx",
                "content_base64": base64.b64encode(docx_buffer.getvalue()).decode("ascii"),
                "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }
        )
        expect(docx_upload["document"]["metadata"]["parser"] == "docx-xml", "docx upload extracts office XML text")
        url_upload = engine.ingest_url(
            {
                "customer_id": "acme",
                "url": "https://93.184.216.34/customer-runbook",
                "content": "URL ingest keeps PBS wiki compilation metadata for external customer knowledge.",
                "auto_compile_wiki": True,
            }
        )
        expect(url_upload["document"]["metadata"]["pbs_payload"]["auto_compile_wiki"] is True, "URL ingest records PBS wiki compile contract")
        reports = engine.upload_reports("acme")
        expect(reports["counts"]["documents"] == 4, "upload reports list indexed documents")
        rag = engine.search({"customer_id": "acme", "question": "router latency 원인"})
        expect(rag["citations"], "rag query returns citations")
        other_owner = engine.search({"customer_id": "acme", "question": "router latency 원인"}, owner_id="other-user")
        expect(not other_owner["citations"], "rag query isolates owner scope")
        wiki = engine.run_wiki_loop(customer_id="acme")
        expect(wiki["notes_upserted"] >= 1, "wiki loop upserts notes")
        vault = engine.wiki_vault("acme")
        expect(vault["notes"], "wiki vault returns notes")
        topology = engine.topology("acme")
        expect(topology["counts"]["nodes"] >= 2, "topology returns graph nodes")
        note = engine.save_note(
            {
                "customer_id": "acme",
                "title": "Router Latency Follow-up",
                "body": "운영 메모: [[router]] latency는 route shard와 연결된다.",
            }
        )
        expect(note["note"]["links"] == ["router"], "manual wiki note extracts wikilinks")
    print("Knowledge engine self-test passed.")


if __name__ == "__main__":
    main()
