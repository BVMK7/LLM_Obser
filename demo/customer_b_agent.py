"""
Demo script: "Customer B" onboards onto the platform and connects a
different toy agent using the llmobs SDK. Run alongside
customer_a_agent.py — same platform, same code path, completely separate
project/data.

Requires the SDK installed locally first: `pip install -e sdk/`
"""

import time

import requests

from llmobs import Client

BASE_URL = "http://localhost:8010"
CUSTOMER_NAME = "Customer B — Globex Research Assistant"


def onboard() -> str:
    resp = requests.post(f"{BASE_URL}/projects", json={"name": CUSTOMER_NAME}, timeout=10)
    resp.raise_for_status()
    project = resp.json()
    print(f"Onboarded project {project['name']!r} (id={project['id']})")
    print(f"API key (shown once): {project['api_key']}")
    return project["api_key"]


def search_papers(client: Client, topic: str) -> str:
    @client.traced("search_papers")
    def _run():
        time.sleep(0.05)
        return f"[fake paper abstracts about: {topic}]"

    return _run()


def summarize_findings(client: Client, topic: str, papers: str) -> str:
    @client.traced("summarize_findings")
    def _run():
        time.sleep(0.1)
        return f"Summary of {papers} on '{topic}': the key finding is..."

    return _run()


def research_query(client: Client, topic: str) -> str:
    @client.traced("research_query")
    def _run():
        papers = search_papers(client, topic)
        return summarize_findings(client, topic, papers)

    return _run()


if __name__ == "__main__":
    api_key = onboard()
    client = Client(api_key=api_key, base_url=BASE_URL)

    topics = [
        "battery energy density improvements",
        "protein folding prediction accuracy",
    ]
    for topic in topics:
        answer = research_query(client, topic)
        print(f"- {topic!r} -> {answer!r}")

    print("\nDone. Switch the frontend's project dropdown to this project to see only these traces.")
