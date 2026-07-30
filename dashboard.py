"""
Simple Streamlit dashboard for the llm_observability database.
Run with: streamlit run dashboard.py
"""

import os

import pandas as pd
import streamlit as st
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# 1. Connect to the PostgreSQL database.
# We reuse the same DATABASE_URL from .env that the FastAPI app uses --
# Streamlit talks to Postgres directly, it doesn't go through the API.
# pandas needs an open Connection (not just the Engine) to run queries against.
load_dotenv()
engine = create_engine(os.environ["DATABASE_URL"])
conn = engine.connect()


def run_query(sql, params=None):
    """Run a SQL query and return the results as a pandas DataFrame."""
    result = conn.execute(text(sql), params or {})
    return pd.DataFrame(result.fetchall(), columns=list(result.keys()))


st.set_page_config(page_title="LLM Observability", layout="wide")
st.title("LLM Observability Dashboard")

# 2. Fetch all rows from "traces" and load them into a table (a DataFrame).
traces_df = run_query("SELECT * FROM traces ORDER BY started_at DESC")

st.subheader("Traces")
st.dataframe(traces_df, use_container_width=True)

# 3. Show total cost and total tokens, summed across all traces.
# .sum() on a pandas column adds up every value in that column.
# Empty tables would make .sum() return 0, which is fine to display.
total_cost = traces_df["cost"].sum()
total_tokens = traces_df["total_tokens"].sum()

col1, col2 = st.columns(2)
col1.metric("Total cost", f"${total_cost:.4f}")
col2.metric("Total tokens", f"{total_tokens:,}")

# 4. Let the user pick a trace, then show its related spans below.
st.subheader("Inspect a trace")

if traces_df.empty:
    st.info("No traces yet.")
else:
    # Build a dropdown of "name (id)" options so it's easy to read,
    # then look up which trace that corresponds to.
    options = [f"{row['name']} ({row['id']})" for _, row in traces_df.iterrows()]
    selected_option = st.selectbox("Choose a trace", options)
    selected_trace_id = selected_option.split("(")[-1].rstrip(")")

    spans_df = run_query(
        "SELECT * FROM spans WHERE trace_id = :trace_id ORDER BY started_at",
        {"trace_id": selected_trace_id},
    )

    st.write(f"Spans for trace `{selected_trace_id}`:")
    if spans_df.empty:
        st.info("This trace has no spans.")
    else:
        st.dataframe(spans_df, use_container_width=True)
