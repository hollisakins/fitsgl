#!/usr/bin/env python3
"""Add dev/preview origins to an R2 bucket's CORS rule (one-off, re-runnable).

`fitsgl deploy` sets bucket CORS to the single ``viewer_origin`` from
``fitsgl.toml`` on every run (deploy.py), which wipes any extra origins added
here — re-run this script after a deploy if you pinned ``viewer_origin``.
(If ``viewer_origin`` was never set it defaults to ``"*"`` and dev origins are
already allowed; this script is unnecessary then.)

The script MERGES: it reads the bucket's current CORS rule, adds the given
origins, and writes it back with the same expose-headers the viewer's ranged
tile fetches need (mirrors deploy.py's ``_CORS_EXPOSE``).

Credentials come from the environment, same as ``fitsgl deploy``:
    R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

Usage:
    python scripts/set_dev_cors.py \
        --bucket my-bucket \
        --endpoint https://<account-id>.r2.cloudflarestorage.com \
        https://my-fitsgl-preview.vercel.app "https://*.vercel.app" http://localhost:5173

Needs boto3 (``pip install boto3`` or the ``fitsgl[deploy]`` extra). R2 allows
one ``*`` wildcard per origin (e.g. ``https://*.vercel.app`` covers every
preview deployment).
"""

from __future__ import annotations

import argparse
import os
import sys

# Mirrors fitsgl-py/src/fitsgl/deploy.py::_CORS_EXPOSE — headers the viewer's
# ranged tile fetches must be able to read cross-origin.
CORS_EXPOSE = ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bucket", required=True, help="R2 bucket name")
    parser.add_argument(
        "--endpoint", required=True, help="R2 S3 endpoint, https://<account-id>.r2.cloudflarestorage.com"
    )
    parser.add_argument("origins", nargs="+", help="origins to allow (added to any already present)")
    parser.add_argument("--dry-run", action="store_true", help="print the resulting rule without writing")
    args = parser.parse_args()

    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not access_key or not secret_key:
        print("error: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (same env as `fitsgl deploy`)", file=sys.stderr)
        return 2

    try:
        import boto3
        from botocore.exceptions import ClientError
    except ImportError:
        print("error: boto3 is required — pip install boto3 (or 'fitsgl[deploy]')", file=sys.stderr)
        return 2

    s3 = boto3.client(
        "s3",
        endpoint_url=args.endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )

    # Read the current rule so this merges instead of clobbering.
    try:
        current = s3.get_bucket_cors(Bucket=args.bucket)["CORSRules"]
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("NoSuchCORSConfiguration", "CORSConfigurationNotFound"):
            current = []
        else:
            print(f"error: get_bucket_cors failed: {e}", file=sys.stderr)
            return 1

    if current:
        rule = current[0]
        merged = list(dict.fromkeys([*rule.get("AllowedOrigins", []), *args.origins]))
        rule["AllowedOrigins"] = merged
        # Ensure the range-fetch essentials survive whatever rule was there.
        rule["AllowedMethods"] = sorted({*rule.get("AllowedMethods", []), "GET", "HEAD"})
        rule["AllowedHeaders"] = list(dict.fromkeys([*rule.get("AllowedHeaders", []), "range"]))
        rule["ExposeHeaders"] = list(dict.fromkeys([*rule.get("ExposeHeaders", []), *CORS_EXPOSE]))
        rules = current
    else:
        rules = [
            {
                "AllowedOrigins": list(dict.fromkeys(args.origins)),
                "AllowedMethods": ["GET", "HEAD"],
                "AllowedHeaders": ["range"],
                "ExposeHeaders": CORS_EXPOSE,
                "MaxAgeSeconds": 3600,
            }
        ]

    print(f"CORS rule for bucket {args.bucket!r}:")
    for o in rules[0]["AllowedOrigins"]:
        print(f"  origin: {o}")
    if args.dry_run:
        print("(dry run — nothing written)")
        return 0

    try:
        s3.put_bucket_cors(Bucket=args.bucket, CORSConfiguration={"CORSRules": rules})
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "AccessDenied":
            print(
                "error: AccessDenied — bucket CORS needs an 'Admin Read & Write' R2 token "
                "(an Object Read & Write token cannot change bucket config; see docs/r2-setup.md §4a)",
                file=sys.stderr,
            )
            return 1
        print(f"error: put_bucket_cors failed: {e}", file=sys.stderr)
        return 1
    print("written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
