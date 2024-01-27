function toggleDescription(event) {
    event = event || window.event;
    var source = event.target || event.srcElement;

    parent = source.parentElement;

    if (parent.nextElementSibling.className == 'hidden-item') {
        parent.nextElementSibling.className = 'shown-item';
    } else {
        parent.nextElementSibling.className = 'hidden-item';
    }

    if (parent.className == 'inactive') {
        parent.className = 'active';
    }
    else {
        parent.className = 'inactive';
    }
}

window.onload = function () {
    for (var elem of document.getElementsByTagName('li')) {
        elem.addEventListener('click', toggleDescription);
    }
}