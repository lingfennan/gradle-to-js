# Fixed Bugs #
1. fails parsing block name if there is no spaces between block name and new blocks, i.e in test/sample-data/fail1.build.gradle, ext{ XXX} was not resolved
2. ext variables are not globally visible, and not resolved when parsing dependencies, as in test/sample-data/fail1.build.gradle.
3. variables in dependencies are not resolved, actually, in any value, that contains this value
4. resolve dependency values from other scripts

# Bugs To Fix #
1. dependencies from fileTree and file
2. dependencies from project
3. complex dependencies, e.g. /data/gpl_violation/data/groundtruth-latest/SRC_comp/org.kontalk_124_src.tar.gz/app/build.gradle
