#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && valueParts.length) env[key.trim()] = valueParts.join('=').trim();
});

const LINEAR_API_KEY = env.LINEAR_API_KEY;

async function getWorkflowStates(teamId) {
  const query = `query { workflowStates(filter: { team: { id: { eq: "${teamId}" } } }) { nodes { id name type } } }`;
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': LINEAR_API_KEY },
    body: JSON.stringify({ query })
  });
  return response.json();
}

async function getIssueId(identifier) {
  const query = `query { issue(id: "${identifier}") { id title state { name } } }`;
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': LINEAR_API_KEY },
    body: JSON.stringify({ query })
  });
  return response.json();
}

async function updateIssueStatus(issueIdentifier, newStateName) {
  // First get the issue details
  const issueResult = await getIssueId(issueIdentifier);
  if (!issueResult.data?.issue) {
    console.log('Issue not found:', issueIdentifier);
    return;
  }

  const issueId = issueResult.data.issue.id;
  console.log(`Found issue: ${issueIdentifier} (${issueResult.data.issue.title})`);
  console.log(`Current status: ${issueResult.data.issue.state.name}`);

  // Get workflow states for PDD team
  const TEAM_ID = "daa91240-92e1-4a78-8cc7-a53684a431b1";
  const statesResult = await getWorkflowStates(TEAM_ID);
  const states = statesResult.data?.workflowStates?.nodes || [];

  const targetState = states.find(s => s.name.toLowerCase() === newStateName.toLowerCase());
  if (!targetState) {
    console.log('State not found:', newStateName);
    console.log('Available states:', states.map(s => s.name).join(', '));
    return;
  }

  // Update the issue
  const mutation = `mutation { issueUpdate(id: "${issueId}", input: { stateId: "${targetState.id}" }) { success issue { identifier state { name } } } }`;
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': LINEAR_API_KEY },
    body: JSON.stringify({ query: mutation })
  });

  const result = await response.json();
  if (result.data?.issueUpdate?.success) {
    console.log(`✓ Updated to: ${result.data.issueUpdate.issue.state.name}`);
  } else {
    console.log('Failed:', result.errors?.[0]?.message);
  }
}

const identifier = process.argv[2];
const status = process.argv[3];

if (!identifier || !status) {
  console.log('Usage: node linear-update-status.js <issue-identifier> <status>');
  console.log('Example: node linear-update-status.js PDD-34 "In Progress"');
  process.exit(1);
}

updateIssueStatus(identifier, status);
