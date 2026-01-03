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

async function listBacklog() {
  const query = `{
    issues(filter: {
      team: { key: { eq: "PDD" } },
      state: { type: { in: ["backlog", "unstarted"] } }
    }, first: 20, orderBy: updatedAt) {
      nodes {
        identifier
        title
        state { name }
        priority
      }
    }
  }`;

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': env.LINEAR_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const result = await response.json();
  const issues = result.data?.issues?.nodes || [];

  console.log('Backlog issues:\n');
  issues.forEach(issue => {
    console.log(`${issue.identifier}: ${issue.title} [${issue.state.name}]`);
  });
}

listBacklog();
