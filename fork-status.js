/**
 * Composer Fork Status Reporter
 *
 * This script reads composer.json, finds all forked repositories (from the repositories section),
 * matches them to dependencies in require/require-dev, and for each fork:
 *   - Determines the branch in use (from dev-<branch> version constraints)
 *   - Fetches the last commit date for that branch from GitHub
 *   - Finds any open PR for that branch and whether it is merged
 *   - Fetches the repo description
 *   - Outputs a markdown table with Age, Package, Branch, Fork PR, Merged, and Description columns
 *
 * Usage: node fork-status.js
 *
 * Set GITHUB_TOKEN in the environment for higher GitHub API rate limits.
 * Set DEBUG=1 for verbose debug output.
 */

import fs from 'fs';
import https from 'https';

// Path to composer.json (can be overridden by env var)
const composerPath = process.env.COMPOSER_JSON || '../fenz-hazard/composer.json';
// Read and parse composer.json
const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
// Merge require and require-dev into a single dependencies object
const requireSections = [composer.require || {}, composer['require-dev'] || {}];
const dependencies = Object.assign({}, ...requireSections);
// Get all VCS forks from the repositories section
const forks = (composer.repositories || []).filter(r => r.type === 'vcs' && r.url.includes('github.com'));

// Markdown table header and divider
const tableHeader = '| Age | Package | Branch | Fork PR | Merged | Description |';
const tableDivider = '| ---- | ------- | ------ | ------- | ------ | ----------- |';

console.log(tableHeader);
console.log(tableDivider);

/**
 * Make a GET request to the GitHub API and parse the JSON response.
 * Prints debug info if DEBUG=1 is set.
 * @param {string} path - The API path (e.g. /repos/owner/repo/commits)
 * @returns {Promise<any>} - The parsed JSON response
 */
function githubApi(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        'User-Agent': 'composer-forks-action',
        'Accept': 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      }
    };
    let data = '';
    let statusCode = 0;
    const req = https.get(options, res => {
      statusCode = res.statusCode;
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (process.env.DEBUG) {
          console.error(`DEBUG: [${path}] HTTP ${statusCode}`);
          console.error(`DEBUG: [${path}] Raw body:`, data);
        }
        if (statusCode >= 200 && statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
        } else {
          resolve({});
        }
      });
    });
    req.on('error', reject);
  });
}

/**
 * Convert an ISO date string to a relative time string (e.g. '2 days ago').
 * Handles pluralization.
 * @param {string} dateStr - ISO date string
 * @returns {string} - Relative time string
 */
function relativeTime(dateStr) {
  if (!dateStr) return '-';
  const then = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff} second${diff === 1 ? '' : 's'} ago`;
  if (diff < 3600) {
    const m = Math.floor(diff/60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff/3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  if (diff < 2592000) {
    const d = Math.floor(diff/86400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  if (diff < 31536000) {
    const mo = Math.floor(diff/2592000);
    return `${mo} month${mo === 1 ? '' : 's'} ago`;
  }
  const y = Math.floor(diff/31536000);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

/**
 * Truncate a string to a max length, adding ellipsis if needed.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
  if (!str) return '-';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Fetch and truncate the GitHub repo description.
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string>}
 */
async function getRepoDescription(owner, repo) {
  let description = '-';
  try {
    const repoInfo = await githubApi(`/repos/${owner}/${repo}`);
    if (repoInfo && repoInfo.description) {
      description = truncate(repoInfo.description, 25);
    }
  } catch (e) {
    if (process.env.DEBUG) {
      console.error(`DEBUG: Error fetching repo description for ${owner}/${repo}:`, e);
    }
  }
  return description;
}

/**
 * Get the last commit date for a branch, as a relative time string.
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @returns {Promise<string>} Age string or '-'
 */
async function getBranchAge(owner, repo, branch) {
  let age = '-';
  try {
    const apiPath = `/repos/${owner}/${repo}/commits?sha=${branch}&per_page=1`;
    if (process.env.DEBUG) {
      console.error(`DEBUG: Fetching commits from: https://api.github.com${apiPath}`);
    }
    const commits = await githubApi(apiPath);
    if (process.env.DEBUG) {
      console.error('DEBUG: Commits API response:', JSON.stringify(commits, null, 2));
    }
    if (Array.isArray(commits) && commits[0] && commits[0].commit && commits[0].commit.author && commits[0].commit.author.date) {
      age = relativeTime(commits[0].commit.author.date);
    } else {
      if (process.env.DEBUG) {
        console.error(`DEBUG: No commit found for ${owner}/${repo} branch ${branch}`);
      }
    }
  } catch (e) {
    if (process.env.DEBUG) {
      console.error(`DEBUG: Error fetching commit for ${owner}/${repo} branch ${branch}:`, e);
    }
  }
  return age;
}

/**
 * Get PR and merge status for a branch.
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @returns {Promise<{forkPr: string, forkMerged: string}>}
 */
async function getPRInfo(owner, repo, branch) {
  let forkPr = 'No PR', forkMerged = '-';
  try {
    const pulls = await githubApi(`/repos/${owner}/${repo}/pulls?head=${owner}:${branch}`);
    if (Array.isArray(pulls) && pulls[0]) {
      forkPr = `[PR](${pulls[0].html_url})`;
      // Check merged status
      const prNum = pulls[0].number;
      const prMerge = await githubApi(`/repos/${owner}/${repo}/pulls/${prNum}/merge`);
      forkMerged = prMerge && prMerge.merged ? 'Yes' : 'No';
    }
  } catch (e) {
    if (process.env.DEBUG) {
      console.error(`DEBUG: Error fetching PR for ${owner}/${repo} branch ${branch}:`, e);
    }
  }
  return { forkPr, forkMerged };
}

/**
 * For a given fork, output a markdown table row with age, package, branch, PR, merge status, and description.
 * @param {object} fork - The fork repo object from composer.json
 * @returns {Promise<string>} - The markdown table row
 */
async function getForkStatus(fork) {
  // Extract repo URL and name
  const repoUrl = fork.url;
  const repoName = repoUrl.replace(/\.git$/, '').split('/').pop();
  // Find the matching dependency (by suffix match)
  const match = Object.entries(dependencies).find(([pkg, ver]) => pkg.endsWith(repoName));
  // Extract owner and repo from URL
  let owner, repo;
  try {
    [owner, repo] = repoUrl.match(/github.com[:/]+([^/]+)\/([^/.]+)/).slice(1, 3);
  } catch {
    owner = repo = undefined;
  }
  // Always fetch and truncate repo description
  const description = owner && repo ? await getRepoDescription(owner, repo) : '-';
  if (!match) {
    // If no matching dependency, output dashes but include description
    return `| - | [${repoName}](${repoUrl.replace('git@github.com:', 'https://github.com/').replace('git://github.com/', 'https://github.com/').replace('https://github.com/', 'https://github.com/')}) | - | - | - | ${description} |`;
  }
  const [pkg, version] = match;
  let branch = '-';
  // Only use dev- branches
  if (version.startsWith('dev-')) branch = version.replace(/^dev-/, '');
  else return `| - | [${repoName}](${repoUrl.replace('git@github.com:', 'https://github.com/').replace('git://github.com/', 'https://github.com/').replace('https://github.com/', 'https://github.com/')}) | - | - | - | ${description} |`;
  // Markdown links for package and branch
  const pkgLink = `[${repoName}](https://github.com/${owner}/${repo})`;
  const branchLink = `[${branch}](https://github.com/${owner}/${repo}/tree/${branch})`;
  // Get last commit date for the branch
  const age = owner && repo ? await getBranchAge(owner, repo, branch) : '-';
  // Get PR status for the branch
  const { forkPr, forkMerged } = owner && repo ? await getPRInfo(owner, repo, branch) : { forkPr: 'No PR', forkMerged: '-' };
  // Return the markdown table row
  return `| ${age} | ${pkgLink} | ${branchLink} | ${forkPr} | ${forkMerged} | ${description} |`;
}

// Main async runner: process each fork and print the table row
(async () => {
  for (const fork of forks) {
    const row = await getForkStatus(fork);
    console.log(row);
  }
})();
