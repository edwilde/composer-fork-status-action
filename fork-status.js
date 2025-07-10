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

/**
 * Debug utility function to log messages when DEBUG=1 is set
 * Sends debug output to stderr so it doesn't interfere with the table output
 * @param {...any} args - Arguments to log (same format as console.error)
 */
function debug(...args) {
  // Early return if DEBUG is not enabled
  if (!process.env.DEBUG) return;

  console.error('DEBUG:', ...args);
}

/**
 * Normalize a GitHub URL to a consistent HTTPS format
 * @param {string} url - The GitHub URL to normalize
 * @returns {string} - Normalized HTTPS GitHub URL
 */
function normalizeGitHubUrl(url) {
  return url
    .replace('git@github.com:', 'https://github.com/')
    .replace('git://github.com/', 'https://github.com/')
    .replace('https://github.com/', 'https://github.com/');
}

/**
 * Get package name from GitHub repository by fetching its composer.json
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branch - Optional branch name, defaults to main/master
 * @returns {Promise<string|null>} - Package name or null if not found
 */
async function getPackageNameFromRepo(owner, repo, branch = null) {
  try {
    // Try common default branches if no branch specified
    const branchesToTry = branch ? [branch] : ['main', 'master', 'develop'];

    for (const branchName of branchesToTry) {
      debug(`Trying to fetch composer.json from ${owner}/${repo} branch ${branchName}`);

      // Build the URL to the raw composer.json file
      const composerJsonPath = `/repos/${owner}/${repo}/contents/composer.json?ref=${branchName}`;
      const repoContent = await githubApi(composerJsonPath);

      if (repoContent && repoContent.content) {
        // Content is base64 encoded
        const contentBuffer = Buffer.from(repoContent.content, 'base64');
        const composerJson = JSON.parse(contentBuffer.toString());

        if (composerJson.name) {
          debug(`Found package name in composer.json: ${composerJson.name}`);
          return composerJson.name;
        }
      }
    }

    debug(`No composer.json found or no name property in ${owner}/${repo}`);
    return null;
  } catch (e) {
    debug(`Error fetching composer.json for ${owner}/${repo}:`, e.message);
    return null;
  }
}

// Path to composer.json (can be overridden by env var)
const composerPath = process.env.COMPOSER_JSON || './composer.json';
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
        debug(`[${path}] HTTP ${statusCode}`);
        debug(`[${path}] Raw body:`, data);

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
    debug(`Error fetching repo description for ${owner}/${repo}:`, e);
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
    // Encode branch name for URL safety
    const encodedBranch = encodeURIComponent(branch);
    const apiPath = `/repos/${owner}/${repo}/commits?sha=${encodedBranch}&per_page=1`;

    debug(`Fetching commits from: https://api.github.com${apiPath}`);

    const commits = await githubApi(apiPath);
    debug('Commits API response:', JSON.stringify(commits, null, 2));

    if (Array.isArray(commits) && commits[0] && commits[0].commit && commits[0].commit.author && commits[0].commit.author.date) {
      age = relativeTime(commits[0].commit.author.date);
    } else {
      debug(`No commit found for ${owner}/${repo} branch ${branch}`);
    }
  } catch (e) {
    debug(`Error fetching commit for ${owner}/${repo} branch ${branch}:`, e);
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
    // Encode the branch name properly for URLs, especially important for branches with slashes
    const encodedBranch = encodeURIComponent(branch);

    debug(`Checking PRs for ${owner}/${repo} branch "${branch}" (encoded as "${encodedBranch}")`);

    // GitHub API requires the format "owner:branch" for the head parameter
    const pulls = await githubApi(`/repos/${owner}/${repo}/pulls?head=${owner}:${encodedBranch}`);

    debug(`Found ${Array.isArray(pulls) ? pulls.length : 0} PRs for branch ${branch}`);

    if (Array.isArray(pulls) && pulls[0]) {
      forkPr = `[PR](${pulls[0].html_url})`;
      // Check merged status
      const prNum = pulls[0].number;
      const prMerge = await githubApi(`/repos/${owner}/${repo}/pulls/${prNum}/merge`);
      forkMerged = prMerge && prMerge.merged ? 'Yes' : 'No';

      debug(`PR found at ${pulls[0].html_url}, merged status: ${forkMerged}`);
    }
  } catch (e) {
    debug(`Error fetching PR for ${owner}/${repo} branch ${branch}:`, e);
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

  // Log all dependencies for debugging
  debug(`Looking for dependencies matching ${repoName}`);
  debug(`Repository name is: ${repoName}`);
  debug(`All dependencies:`, JSON.stringify(dependencies, null, 2));

  // Extract owner and repo from URL - handling different URL formats
  let owner, repo;
  try {
    const urlMatch = repoUrl.match(/github\.com[:/]+([^/]+)\/([^/.]+)/);
    if (urlMatch && urlMatch.length >= 3) {
      owner = urlMatch[1];
      repo = urlMatch[2];
    }
  } catch {
    owner = repo = undefined;
  }

  debug(`Extracted owner: ${owner}, repo: ${repo} from URL: ${repoUrl}`);

  // Try to get package name directly from the repository's composer.json
  let match = null;
  if (owner && repo) {
    const packageNameFromRepo = await getPackageNameFromRepo(owner, repo);
    if (packageNameFromRepo && dependencies[packageNameFromRepo]) {
      match = [packageNameFromRepo, dependencies[packageNameFromRepo]];
      debug(`Found match using package name from composer.json: ${packageNameFromRepo}`);
    }
  }

  // If no match by package name from repo, check for direct name match (case insensitive)
  if (!match) {
    const exactMatches = Object.entries(dependencies).filter(([pkg, ver]) => {
      const pkgName = pkg.split('/').pop(); // Get the last part after '/'
      const pkgNameLower = pkgName.toLowerCase();
      const repoNameLower = repoName.toLowerCase();
      return pkgNameLower === repoNameLower;
    });

    if (exactMatches.length > 0) {
      match = exactMatches[0];
      debug(`Found exact package name match: ${match[0]}`);
    } else {
      debug(`Using repository name: ${repoName}`);

      // Try to find by package name component (case insensitive)
      match = Object.entries(dependencies).find(([pkg, ver]) => {
        const pkgName = pkg.split('/').pop().toLowerCase(); // Get last part after '/' and normalize case
        const repoNameLower = repoName.toLowerCase();
        const pkgNameMatch = pkgName === repoNameLower;

        if (pkgNameMatch) {
          debug(`Package name component match: ${pkg} matches ${repoName}`);
        }

        return pkgNameMatch;
      });

      if (match) {
        debug(`Found name match: ${match[0]}`);
      }

      // Try to match using vendor from URL + repo name
      if (!match && owner) {
        const potentialPackageName = `${owner.toLowerCase()}/${repoName.toLowerCase()}`;
        debug(`Checking for package with name: ${potentialPackageName}`);

        const vendorMatches = Object.entries(dependencies).filter(([pkg, ver]) => {
          return pkg.toLowerCase() === potentialPackageName;
        });

        if (vendorMatches.length > 0) {
          match = vendorMatches[0];
          debug(`Found vendor + repo match: ${match[0]}`);
        }
      }

      // Also check for full package name matches as a fallback
      if (!match) {
        const fullNameMatches = Object.entries(dependencies).filter(([pkg, ver]) => {
          // Check for variations that include the repo name in the package name
          return pkg.includes(repoName.toLowerCase());
        });

        if (fullNameMatches.length > 0) {
          match = fullNameMatches[0];
          debug(`Found full package name match: ${match[0]}`);
        }
      }

      // If still no match, try suffix match as last resort
      if (!match) {
        match = Object.entries(dependencies).find(([pkg, ver]) => {
          return pkg.toLowerCase().endsWith(repoName.toLowerCase());
        });

        if (match) {
          debug(`Found suffix match: ${match[0]}`);
        }
      }
    }
  }

  // Debug the match if found
  if (match) {
    debug(`Found matching dependency for ${repoName}:`, match);
  } else {
    debug(`No matching dependency found for ${repoName}`);
  }

  // Always fetch and truncate repo description
  const description = owner && repo ? await getRepoDescription(owner, repo) : '-';

  // If no matching dependency, output dashes but include description
  if (!match) {
    return `| - | [${repoName}](${normalizeGitHubUrl(repoUrl)}) | - | - | - | ${description} |`;
  }

  const [pkg, version] = match;
  let branch = '-';

  // Debug the version string
  debug(`Processing version string for ${pkg}: "${version}"`);

  // Early return for non-dev versions
  if (!version.startsWith('dev-')) {
    debug(`Not a dev- version: "${version}"`);
    return `| - | [${repoName}](${normalizeGitHubUrl(repoUrl)}) | - | - | - | ${description} |`;
  }

  // Extract the branch name from formats like: 'dev-branch' or 'dev-branch as version'
  const asIndex = version.indexOf(' as ');
  if (asIndex !== -1) {
    // For 'dev-branch as version' format, extract just the branch part
    branch = version.substring(4, asIndex);
    debug(`Extracted branch name "${branch}" from aliased version string`);
  } else {
    // For simple 'dev-branch' format
    branch = version.replace(/^dev-/, '');
    debug(`Extracted branch name "${branch}" from simple dev- version string`);
  }

  // Additional debug info for complex branch names
  if (branch.includes('/')) {
    debug(`Branch name contains slashes: "${branch}"`);
  }
  // Markdown links for package and branch
  const pkgLink = `[${repoName}](https://github.com/${owner}/${repo})`;
  // URL encode the branch for the link
  const encodedBranchForUrl = encodeURIComponent(branch);
  const branchLink = `[${branch}](https://github.com/${owner}/${repo}/tree/${encodedBranchForUrl})`;
  // Get last commit date for the branch
  const age = owner && repo ? await getBranchAge(owner, repo, branch) : '-';
  // Get PR status for the branch
  const { forkPr, forkMerged } = owner && repo ? await getPRInfo(owner, repo, branch) : { forkPr: 'No PR', forkMerged: '-' };
  // Return the markdown table row
  return `| ${age} | ${pkgLink} | ${branchLink} | ${forkPr} | ${forkMerged} | ${description} |`;
}

// Main async runner: process each fork and build the table
(async () => {
  const output = [tableHeader, tableDivider];
  for (const fork of forks) {
    const row = await getForkStatus(fork);
    output.push(row);
  }

  const finalOutput = output.join('\n');

  // Log to console for debugging/visibility in action logs
  console.log(finalOutput);

  // Set the action output
  if (process.env.GITHUB_OUTPUT) {
    // Use a unique delimiter for the multiline output
    const delimiter = `EOF_${Math.random().toString(36).substring(7)}`;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `fork_status<<${delimiter}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${finalOutput}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${delimiter}\n`);
  }
})();
