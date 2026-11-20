import numpy as np

from disagree import wquantiles


def test_weighted_quantiles_of_whole_metres_are_not_shifted_by_half_a_bin():
    # the inputs are integer-metre differences; the middle of bin [11, 12) reported 11.5
    assert wquantiles(np.array([10, 10, 11, 12, 40.0]), np.ones(5), (0.5,), 0, 100, 1.0) == [11.0]
    assert wquantiles(np.array([-3, -1, 0, 2.0]), np.array([1, 1, 1, 1.0]), (0.25, 0.75), -100, 100, 1.0) == [-3.0, 0.0]
