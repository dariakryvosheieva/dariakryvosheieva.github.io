function toggleDescription(event) {
    event = event || window.event;
    var source = event.target || event.srcElement;

    if (source.nextElementSibling.className == 'hidden-item') {
        source.nextElementSibling.className = '';
    } else {
        source.nextElementSibling.className = 'hidden-item';
    }

    var parent = source.parentNode;
    if (parent.className == 'inactive') {
        parent.className = 'active';
    }
    else {
        parent.className = 'inactive';
    }
}

window.onload = function () {
    for (var elem of document.getElementsByClassName('research-interest')) {
        elem.addEventListener('click', toggleDescription);
    }
}