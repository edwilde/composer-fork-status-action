# Composer Fork Status Action

This action generates a markdown table reporting the status of any forks defined in your `composer.json` repositories section, including branch, PR, merge status, last commit age, and a brief description. This is handy for adding to a pull request output.

## Usage

In your workflow, define a step which refers to the action:

```yml
  steps:
    # ...
    - name: Composer Fork Status
      id: composer_fork_status
      uses: edwilde/composer-fork-status-action@1
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- The `GITHUB_TOKEN` is required for higher GitHub API rate limits and to fetch fork/PR status and descriptions.

## Preview

This is an example of the output for the fork/PR status table:

| Age | Package | Branch | Fork PR | Merged |
| ---- | ------- | ------ | ------- | ------ |
| 9 months ago | [silverstripe-date-range-field](https://github.com/silverstripeltd/silverstripe-date-range-field) | [feature/support-cms-5](https://github.com/silverstripeltd/silverstripe-date-range-field/tree/feature/support-cms-5) | [PR](https://github.com/silverstripeltd/silverstripe-date-range-field/pull/1) | No |
| 1 year ago | [silverstripe-googlemapfield](https://github.com/silverstripeltd/silverstripe-googlemapfield) | [cms-5](https://github.com/silverstripeltd/silverstripe-googlemapfield/tree/cms-5) | No PR | - |
| 1 year ago | [silverstripe-iplists](https://github.com/silverstripeltd/silverstripe-iplists) | [feature/cms5](https://github.com/silverstripeltd/silverstripe-iplists/tree/feature/cms5) | No PR | - |
| 1 year ago | [silverstripe-memberprofiles](https://github.com/silverstripeltd/silverstripe-memberprofiles) | [cms-5](https://github.com/silverstripeltd/silverstripe-memberprofiles/tree/cms-5) | No PR | - |

## Inputs

None required.

## Outputs

### Fork/PR status table

For each package that is a fork (defined in the `repositories` section of your `composer.json`), the action will attempt to resolve:

- **Age**: Relative time since the last commit on the branch (e.g. "2 days ago").
- **Package**: Link to the forked repository.
- **Branch**: Link to the branch in use (from the `dev-branch` version constraint).
- **Fork PR**: A link to the pull request if found, or a note if not found.
- **Merged**: Whether the PR has been merged (`Yes`/`No`), or `-` if not applicable.

## Gotchas

### GitHub API Rate Limits

If you see errors or missing data in the fork/PR status table, you may be hitting the GitHub API rate limit. Set the `GITHUB_TOKEN` environment variable to increase your rate limit.
