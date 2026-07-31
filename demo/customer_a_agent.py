"""
Demo script: "Customer A" onboards onto the platform and connects a toy
agent using the llmobs SDK. Run alongside customer_b_agent.py, then open the
frontend and switch the project dropdown between the two to show each only
sees its own data.

Requires the SDK installed locally first: `pip install -e sdk/`
"""

import time

import requests

from llmobs import Client

BASE_URL = "http://localhost:8010"
CUSTOMER_NAME = "Customer A — Acme Support Bot"


def onboard() -> str:
    """Real onboarding, the same one the frontend's "+ New project…" dropdown
    entry calls — this is the "sign up a new customer live" demo moment."""
    resp = requests.post(f"{BASE_URL}/projects", json={"name": CUSTOMER_NAME}, timeout=10)
    resp.raise_for_status()
    project = resp.json()
    print(f"Onboarded project {project['name']!r} (id={project['id']})")
    print(f"API key (shown once): {project['api_key']}")
    return project["api_key"]


def retrieve_context(client: Client, question: str) -> str:
    @client.traced("retrieve_context")
    def _run():
        time.sleep(0.05)
        return f"[fake retrieved doc relevant to: {question}]"

    return _run()


def generate_reply(client: Client, question: str, context: str) -> str:
    @client.traced("generate_reply")
    def _run():
        time.sleep(0.1)
        return f"Thanks for reaching out! Based on {context}, here's the answer to '{question}'."

    return _run()


def handle_support_ticket(client: Client, question: str) -> str:
    @client.traced("handle_support_ticket")
    def _run():
        context = retrieve_context(client, question)
        return generate_reply(client, question, context)

    return _run()


if __name__ == "__main__":
    api_key = onboard()
    client = Client(api_key=api_key, base_url=BASE_URL)

    tickets = [
        "How do I reset my password?",
        "Why was I charged twice this month?",
        "Can I export my data?",
    ]
    for ticket in tickets:
        answer = handle_support_ticket(client, ticket)
        print(f"- {ticket!r} -> {answer!r}")

    print("\nDone. Switch the frontend's project dropdown to this project to see only these traces.")
