import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama"
)

def run_agent_thought(prompt: str):
    response = client.chat.completions.create(
        model="qwen2.5-coder:7b",
        messages=[
            {"role": "system", "content": "You are the core intelligence of humanSi.007, an autonomous private AI agent."},
            {"role": "user", "content": prompt}
        ]
    )
    return response.choices[0].message.content

if __name__ == "__main__":
    print("[*] Initializing humanSi.007 Autonomous Engine locally...")
    thought = run_agent_thought("Analyze repository workspace and propose next build steps.")
    print("\n[Agent Output]:\n", thought)
