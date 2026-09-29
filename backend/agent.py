import ollama
import json

scenario_json = """
{
  "campus": "Campus Gate 2 (10 m curb)",
  "curb_length_m": 10,
  "plan_window": {
    "start": "07:30",
    "end": "13:30"
  },
  "slots": [
    {"id": "BB1", "type": "bus_bay", "label": "Bus bay", "length_m": 4, "capacity": 1},
    {"id": "G1", "type": "general", "label": "General slot 1", "length_m": 3, "capacity": 1},
    {"id": "G2", "type": "general", "label": "General slot 2", "length_m": 3, "capacity": 1}
  ],
  "school_exit": [{"start": "12:30", "end": "13:00", "expected_cars": 18}],
  "bus_trace": [
    {"id": "B12", "arrives": "07:45", "destination": "Tambaram", "dwell_min": 5, "delay_if_blocked_min": 6},
    {"id": "B7", "arrives": "09:40", "destination": "Guindy", "dwell_min": 5, "delay_if_blocked_min": 5},
    {"id": "B12", "arrives": "11:20", "destination": "Tambaram", "dwell_min": 5, "delay_if_blocked_min": 6},
    {"id": "B21", "arrives": "12:30", "destination": "Velachery", "dwell_min": 20, "delay_if_blocked_min": 7},
    {"id": "B7", "arrives": "13:10", "destination": "Guindy", "dwell_min": 5, "delay_if_blocked_min": 5}
  ],
  "bookings": [
    {"id": "T1", "vendor": "Sri Sai Traders", "phone": "+91 90000 11111", "vehicle_type": "freight", "slot_id": "BB1", "start": "12:25", "duration": 30},
    {"id": "T2", "vendor": "Fresh Basket", "phone": "+91 90000 22222", "vehicle_type": "freight", "slot_id": "G2", "start": "11:30", "duration": 25},
    {"id": "T3", "vendor": "Parent (Mrs. Lakshmi)", "phone": "+91 90000 33333", "vehicle_type": "personal", "slot_id": "G1", "start": "10:00", "duration": 15},
    {"id": "T4", "vendor": "Kumar Stationers", "phone": "+91 90000 44444", "vehicle_type": "freight", "slot_id": "G1", "start": "11:00", "duration": 30}
  ],
  "bus_dispatch": {"name": "School Bus Dispatch", "phone": "+91 90000 55555"}
}
"""

rulebook = {
    "curfews": {
        "07:30-08:30": {"allowed": "none", "rule": "no standing"},
        "11:00-13:00": {"allowed": "freight", "rule": "freight only"}
    },
    "zones": {
        "bus_bay": {"allowed": "bus", "rule": "reserved"}
    }
}

def generate_agent_output_local():
    prompt = f"""
    Rulebook: {rulebook}
    Scenario: {scenario_json}
    
    Task 1: Generate a 6-hour curb allocation plan. Ensure the bus bay is kept for the bus and the tempo is moved.
    Task 2: Draft exactly two SMS messages to the vendors to redirect the tempo and confirm the bus.
    """

    print("Sending prompt to local model... (This will take a moment since it is running on your CPU)")
    
    response = ollama.chat(model='llama3.2', messages=[
        {
            'role': 'system',
            'content': 'You are an automated curb-window agent. The rulebook is law. Do not invent bye-laws. Do not tow. If silent, output exactly: "refer to the inspector."'
        },
        {
            'role': 'user',
            'content': prompt
        }
    ])
    
    print("\n=== 6-HOUR CURB PLAN & SMS DRAFTS ===")
    print(response['message']['content'])

if __name__ == "__main__":
    generate_agent_output_local()
