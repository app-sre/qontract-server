#!/usr/bin/env python

import sys
import anymarkup

with open(sys.argv[1], 'r') as schemas_file:
    schemas = anymarkup.parse(schemas_file, force_types=None)

for bf in sys.argv[2:]:
    with open(bf, 'r') as bundle_file:
        bundle = anymarkup.parse(bundle_file, force_types=None)

    bundle['graphql'] = schemas

    anymarkup.serialize_file(bundle, bf)
